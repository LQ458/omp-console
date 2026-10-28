import type { Dirent } from "node:fs";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { PathSuggestions, WorkspaceUsage } from "@omp-console/protocol";

export interface WorkspaceRoots {
	knowledgeRoot?: string;
	projectRoots: readonly string[];
}

export interface SessionUsageSource {
	cwd: string;
	lastActivityAt: number;
	cwdExists?: boolean;
}


const MAX_DIRECTORY_RESULTS = 300;
const MAX_DIRECTORY_SCAN_MS = 750;
const SKIPPED_DIRECTORY_NAMES = new Set([
	"applications",
	"build",
	"dist",
	"library",
	"mobile documents",
	"music",
	"movies",
	"node_modules",
	"pictures",
	"target",
	"vendor",
]);


interface DirectoryMatch {
	path: string;
	root: "knowledge" | "project";
	depth: number;
	rank: number;
}


function within(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export class PathSuggestionError extends Error {
	constructor(directory: string, cause: unknown) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		super(`Could not search folders in ${directory}: ${detail}`, { cause });
		this.name = "PathSuggestionError";
	}
}

async function isRealDirectory(directory: string): Promise<boolean> {
	try {
		const stat = await fs.lstat(directory);
		return stat.isDirectory() && !stat.isSymbolicLink();
	} catch (error) {
		if (isEnoent(error)) return false;
		throw new PathSuggestionError(directory, error);
	}
}
async function directoryEntries(
	parent: string,
	deadline = Date.now() + MAX_DIRECTORY_SCAN_MS,
	limit = MAX_DIRECTORY_RESULTS,
): Promise<Dirent[]> {
	if (Date.now() >= deadline || limit <= 0) return [];
	const entries: Dirent[] = [];
	try {
		const directory = await fs.opendir(parent);
		for await (const entry of directory) {
			if (Date.now() >= deadline || entries.length >= limit) break;
			entries.push(entry);
		}
		return entries.sort((a, b) => a.name.localeCompare(b.name));
	} catch (error) {
		if (isEnoent(error)) return [];
		throw new PathSuggestionError(parent, error);
	}
}

function safeDirectory(entry: Dirent): boolean {
	return entry.isDirectory() &&
		!entry.isSymbolicLink() &&
		!entry.name.startsWith(".") &&
		!SKIPPED_DIRECTORY_NAMES.has(entry.name.toLowerCase());
}

async function directoriesAtDepth(root: string): Promise<Array<{ path: string; depth: number }>> {
	if (!await isRealDirectory(root)) return [];
	const result: Array<{ path: string; depth: number }> = [];
	const deadline = Date.now() + MAX_DIRECTORY_SCAN_MS;
	let parents = [root];
	for (let depth = 1; depth <= 2 && result.length < MAX_DIRECTORY_RESULTS && Date.now() < deadline; depth++) {
		const children: string[] = [];
		for (const parent of parents) {
			if (result.length >= MAX_DIRECTORY_RESULTS || Date.now() >= deadline) break;
			const entries = await directoryEntries(parent, deadline, MAX_DIRECTORY_RESULTS - result.length);
			for (const entry of entries) {
				if (result.length >= MAX_DIRECTORY_RESULTS || Date.now() >= deadline) break;
				if (!safeDirectory(entry)) continue;
				const child = path.join(parent, entry.name);
				result.push({ path: child, depth });
				children.push(child);
			}
		}
		parents = children;
	}
	return result;
}

function matchRank(directory: string, root: string, query: string): number | undefined {
	const name = path.basename(directory).toLowerCase();
	const relative = path.relative(root, directory).toLowerCase();
	if (name === query) return 0;
	if (name.startsWith(query)) return 1;
	if (name.includes(query) || relative.includes(query)) return 2;
	return undefined;
}

function rootRank(root: string, kind: "knowledge" | "project", query: string): number | undefined {
	const label = kind === "knowledge" ? "knowledge" : "project";
	const name = path.basename(root).toLowerCase();
	if (name === query || label === query) return 0;
	if (name.startsWith(query) || label.startsWith(query)) return 1;
	if (name.includes(query) || label.includes(query)) return 2;
	return undefined;
}

function createName(query: string): string | undefined {
	const cleaned = query.trim().replace(/[\\/]+/g, "-").replace(/^\.+|\.+$/g, "");
	if (!cleaned || cleaned === "." || cleaned === "..") return undefined;
	return cleaned;
}

async function exists(target: string): Promise<boolean> {
	try {
		await fs.lstat(target);
		return true;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw new PathSuggestionError(target, error);
	}
}


export async function workspaceSuggestions(
	sessions: readonly SessionUsageSource[],
	roots: WorkspaceRoots,
	now: number,
): Promise<WorkspaceUsage[]> {
	const cutoff = now - 30 * 24 * 60 * 60 * 1000;
	const usage = new Map<string, WorkspaceUsage>();
	const knowledgeRoot = roots.knowledgeRoot === undefined ? undefined : path.resolve(roots.knowledgeRoot);
	const projectRoots = [...roots.projectRoots].map(root => path.resolve(root)).sort((a, b) => b.length - a.length);
	const checkoutRoots = new Set<string>();
	for (const root of projectRoots) {
		try {
			const stat = await fs.lstat(path.join(root, ".git"));
			if (!stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile())) checkoutRoots.add(root);
		} catch (error) {
			if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) {
				throw new PathSuggestionError(path.join(root, ".git"), error);
			}
		}
	}
	for (const session of sessions) {
		if (session.lastActivityAt < cutoff || session.cwdExists === false) continue;
		const cwd = path.resolve(session.cwd);
		let directory: string;
		let name: string;
		let workspaceId: string;
		if (knowledgeRoot !== undefined && within(knowledgeRoot, cwd)) {
			directory = knowledgeRoot;
			name = path.basename(knowledgeRoot);
			workspaceId = "knowledge";
		} else {
			const projectRoot = projectRoots.find(root => within(root, cwd));
			if (projectRoot === undefined) {
				directory = cwd;
				name = path.basename(cwd) || cwd;
				workspaceId = `project:${directory}`;
			} else {
				const child = checkoutRoots.has(projectRoot) ? undefined : path.relative(projectRoot, cwd).split(path.sep)[0];
				directory = child ? path.join(projectRoot, child) : projectRoot;
				name = path.basename(directory) || directory;
				workspaceId = `project:${directory}`;
			}
		}
		const current = usage.get(directory);
		if (current) {
			current.sessions30d++;
			current.lastUsedAt = Math.max(current.lastUsedAt, session.lastActivityAt);
		} else {
			usage.set(directory, { cwd: directory, name, workspaceId, sessions30d: 1, lastUsedAt: session.lastActivityAt });
		}
	}
	return [...usage.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt || a.name.localeCompare(b.name));
}

/** True when `directory`'s real path stays inside the real home and passes the same hidden/heavy-folder rule. */
async function resolvesInsideHome(home: string, directory: string): Promise<boolean> {
	let realHome: string;
	let realDirectory: string;
	try {
		[realHome, realDirectory] = await Promise.all([fs.realpath(home), fs.realpath(directory)]);
	} catch {
		return false;
	}
	if (!within(realHome, realDirectory)) return false;
	const components = path.relative(realHome, realDirectory).split(path.sep).filter(Boolean);
	return !components.some(component => component.startsWith(".") || SKIPPED_DIRECTORY_NAMES.has(component.toLowerCase()));
}

async function homePathSuggestions(queryValue: string, homeDirectory: string, allowCreate: boolean): Promise<PathSuggestions> {
	const home = path.resolve(homeDirectory);
	const input = queryValue.trim();
	const matches = new Map<string, { path: string; exists: true }>();
	const add = (candidate: string): void => {
		matches.set(candidate, { path: candidate, exists: true });
	};
	const output: PathSuggestions = { matches: [] };

	const deadline = Date.now() + MAX_DIRECTORY_SCAN_MS;

	if (input === "" || (!input.startsWith("~") && !input.startsWith("/") && !input.includes("/"))) {
		const needle = input.toLowerCase();
		for (const entry of await directoryEntries(home, deadline)) {
			if (Date.now() >= deadline) break;
			if (!safeDirectory(entry) || (needle !== "" && !entry.name.toLowerCase().includes(needle))) continue;
			add(path.join(home, entry.name));
			if (matches.size >= MAX_DIRECTORY_RESULTS) break;
		}
		const name = createName(input);
		if (allowCreate && name) {
			const candidate = path.resolve(home, name);
			if (within(home, candidate) && !await exists(candidate)) output.create = { path: candidate, root: home };
		}
		output.matches = [...matches.values()];
		return output;
	}

	if (input.startsWith("~") && input !== "~" && !input.startsWith("~/")) return output;
	const relative = input === "~" ? "" : input.startsWith("~/") ? input.slice(2) : input.startsWith("/") ? path.relative(home, path.resolve(input)) : input;
	const candidate = relative === "" ? home : path.resolve(home, relative);
	if (!within(home, candidate)) return output;
	const components = path.relative(home, candidate).split(path.sep).filter(Boolean);
	if (components.some(component => component.startsWith(".") || SKIPPED_DIRECTORY_NAMES.has(component.toLowerCase()))) return output;
	if (input.startsWith("~/")) output.typedPath = candidate;
	const trailingSeparator = input.endsWith("/") || input.endsWith("\\");
	if (candidate === home && !trailingSeparator) add(home);
	else if (!trailingSeparator && await isRealDirectory(candidate) && await resolvesInsideHome(home, candidate)) add(candidate);

	const parent = trailingSeparator ? candidate : path.dirname(candidate);
	// The typed text is checked above; a symlink (~/iCloud -> ~/Library/Mobile Documents) or loop must be checked on
	// the real path too, or listing would reach folders the scan must never touch (macOS privacy prompts).
	if (within(home, parent) && await isRealDirectory(parent) && await resolvesInsideHome(home, parent)) {
		const prefix = trailingSeparator ? "" : path.basename(candidate).toLowerCase();
		for (const entry of await directoryEntries(parent, deadline, MAX_DIRECTORY_RESULTS - matches.size)) {
			if (Date.now() >= deadline) break;
			if (!safeDirectory(entry) || !entry.name.toLowerCase().startsWith(prefix)) continue;
			add(path.join(parent, entry.name));
			if (matches.size >= MAX_DIRECTORY_RESULTS) break;
		}
	}
	if (allowCreate && candidate !== home && !await exists(candidate)) output.create = { path: candidate, root: home };
	output.matches = [...matches.values()];
	return output;
}

export async function suggestPaths(
	queryValue: string,
	roots: WorkspaceRoots,
	homeDirectory = os.homedir(),
): Promise<PathSuggestions> {
	const input = queryValue.trim();
	const query = input.toLowerCase();
	const rootEntries = [
		...(roots.knowledgeRoot === undefined ? [] : [{ path: path.resolve(roots.knowledgeRoot), kind: "knowledge" as const }]),
		...new Set(roots.projectRoots.map(root => path.resolve(root))),
	].map(entry => typeof entry === "string" ? { path: entry, kind: "project" as const } : entry);
	if (rootEntries.length === 0) return homePathSuggestions(input, homeDirectory, true);
	if (input.startsWith("~") || input.startsWith("/")) return homePathSuggestions(input, homeDirectory, false);

	const found = await Promise.all(rootEntries.map(async root => ({ root, directories: await directoriesAtDepth(root.path) })));
	const matches: DirectoryMatch[] = [];
	for (const { root, directories } of found) {
		for (const directory of directories) {
			const rank = query === "" ? 3 : matchRank(directory.path, root.path, query);
			if (rank !== undefined) matches.push({ ...directory, root: root.kind, rank });
		}
	}
	matches.sort((a, b) => a.rank - b.rank || a.depth - b.depth || a.path.localeCompare(b.path));

	const selectedEntry = rootEntries.map(root => {
		const childRank = matches
			.filter(match => match.root === root.kind && within(root.path, match.path))
			.reduce<number | undefined>((best, match) => best === undefined ? match.rank : Math.min(best, match.rank), undefined);
		return { root, rank: childRank ?? (query ? rootRank(root.path, root.kind, query) : undefined) };
	}).sort((a, b) => {
		const rank = (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER);
		if (rank !== 0) return rank;
		if (a.root.kind !== b.root.kind) return a.root.kind === "project" ? -1 : 1;
		return b.root.path.length - a.root.path.length || a.root.path.localeCompare(b.root.path);
	})[0]!.root;
	const output: PathSuggestions = { matches: matches.slice(0, 100).map(match => ({ path: match.path, exists: true })) };
	const name = createName(input);
	if (name) {
		const candidate = path.resolve(selectedEntry.path, name);
		if (within(selectedEntry.path, candidate) && !await exists(candidate)) output.create = { path: candidate, root: selectedEntry.path };
	}
	return output;
}
