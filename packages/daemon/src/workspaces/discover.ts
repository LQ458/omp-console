import type { Workspace } from "@omp-console/protocol";
import { listWorkspaceRules } from "./rules";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface WorkspaceDiscoveryOptions {
	knowledgeRoot?: string;
	/** Explicit directories containing Git checkouts or individual checkout roots. */
	projectRoots?: readonly string[];
	gitTimeoutMs?: number;
}

const GIT_TIMEOUT_MS = 2_000;

function missing(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function isRealDirectory(directory: string): Promise<boolean> {
	try {
		const stat = await fs.lstat(directory);
		return stat.isDirectory() && !stat.isSymbolicLink();
	} catch (error) {
		if (missing(error)) return false;
		throw error;
	}
}

async function isGitCheckout(directory: string): Promise<boolean> {
	try {
		const stat = await fs.lstat(path.join(directory, ".git"));
		return !stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile());
	} catch (error) {
		if (missing(error)) return false;
		throw error;
	}
}


async function gitState(root: string, timeoutMs: number): Promise<Workspace["git"] | undefined> {
	const repo = vcs.git(root);
	if (!repo) return undefined;
	const signal = AbortSignal.timeout(timeoutMs);
	const [branchResult, dirtyResult] = await Promise.allSettled([repo.currentBranch(signal), repo.isDirty(signal)]);
	const branch = branchResult.status === "fulfilled" ? branchResult.value ?? undefined : undefined;
	const state: NonNullable<Workspace["git"]> = {
		dirty: dirtyResult.status === "fulfilled" ? dirtyResult.value : true,
	};
	if (branch !== undefined) state.branch = branch;
	if (branch === undefined || signal.aborted) return state;

	try {
		const upstream = await repo.resolveRef("@{upstream}", signal);
		if (upstream) {
			const [ahead, behind] = await Promise.all([
				repo.revListRange(upstream, "HEAD", signal),
				repo.revListRange("HEAD", upstream, signal),
			]);
			state.ahead = ahead.length;
			state.behind = behind.length;
		}
	} catch {
		// A detached/unconfigured upstream or a timed-out Git query leaves these counts unknown.
	}
	return state;
}

async function projectRoots(parent: string): Promise<string[]> {
	if (!await isRealDirectory(parent)) return [];
	const entries = await fs.readdir(parent, { withFileTypes: true });
	const roots: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
		const candidate = path.join(parent, entry.name);
		if (await isGitCheckout(candidate)) roots.push(path.resolve(candidate));
	}
	return roots;
}

async function resolveExtraRoot(root: string): Promise<string[]> {
	const absolute = path.resolve(root);
	if (!await isRealDirectory(absolute)) return [];
	if (await isGitCheckout(absolute)) return [absolute];
	return projectRoots(absolute);
}

export async function discoverWorkspaces(options: WorkspaceDiscoveryOptions): Promise<Workspace[]> {
	const timeoutMs = options.gitTimeoutMs ?? GIT_TIMEOUT_MS;
	const roots = new Map<string, { id: string; kind: Workspace["kind"]; name: string }>();
	if (options.knowledgeRoot !== undefined) {
		const knowledge = path.resolve(options.knowledgeRoot);
		if (await isRealDirectory(knowledge)) roots.set(knowledge, { id: "knowledge", kind: "knowledge", name: path.basename(knowledge) });
	}

	for (const parent of options.projectRoots ?? []) {
		for (const root of await resolveExtraRoot(parent)) {
			if (roots.has(root)) continue;
			const name = path.basename(root);
			roots.set(root, { id: `project:${name}`, kind: "project", name });
		}
	}

	const workspaces: Workspace[] = [];
	for (const [root, metadata] of [...roots].sort(([left], [right]) => left.localeCompare(right))) {
		// A knowledge root can also be a repository; scratch-like non-repositories report no git state.
		const [rules, git] = await Promise.all([listWorkspaceRules(root), gitState(root, timeoutMs)]);
		workspaces.push({ ...metadata, root, rules, liveSessions: 0, ...(git === undefined ? {} : { git }) });
	}
	return workspaces;
}

export function workspaceOf(cwd: string, workspaces: readonly Workspace[]): Workspace | undefined {
	const candidate = path.resolve(cwd);
	let match: Workspace | undefined;
	for (const workspace of workspaces) {
		const root = path.resolve(workspace.root);
		const contains = candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
		if (contains && (!match || root.length > path.resolve(match.root).length)) match = workspace;
	}
	return match;
}
