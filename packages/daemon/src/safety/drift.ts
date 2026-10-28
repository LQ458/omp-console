import type { DriftSuggestion, WorkspaceKind } from "@omp-console/protocol";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isCodeFile, isEnoent, scanMoveFiles, snapshotPaths } from "./files";

const PROJECT_MARKERS = new Set(["package.json", "Cargo.toml", "pyproject.toml", "go.mod"]);
const CODE_ROOT_MARKER = "src";
const DRIFT_STATE_FILE = "drift-state.json";

interface SessionBaseline {
	root: string;
	files: string[];
	status: string[];
}

interface DriftSnapshot {
	baselines: Array<[string, SessionBaseline]>;
	mutedRoots: Array<[string, string[]]>;
}

export interface DriftOptions {
	/** Test seam and compatibility hook for centralized VCS porcelain output. */
	statusPorcelain?: (cwd: string) => Promise<string>;
}

function parsePorcelainPaths(text: string): string[] {
	const entries = text.includes("\0") ? text.split("\0") : text.split("\n");
	const paths: string[] = [];
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index]!;
		if (entry.length < 4 || entry[2] !== " ") continue;
		paths.push(entry.slice(3).replaceAll("\\", "/"));
		if (/[RC]/.test(entry.slice(0, 2))) index++;
	}
	return paths;
}

async function readStatusPorcelain(cwd: string): Promise<string> {
	const repository = vcs.git(cwd);
	if (!repository) return "";
	return repository.statusPorcelain({ untracked: "all", nulTerminated: true });
}

function prefixPaths(paths: string[], rootPrefix: string): string[] {
	if (!rootPrefix) return paths;
	const prefix = rootPrefix.replaceAll("\\", "/").replace(/\/?$/, "/");
	return paths.filter(item => item.startsWith(prefix)).map(item => item.slice(prefix.length));
}

function normalizedRelative(value: string): string {
	return value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function slugFromRoot(root: string): string {
	const raw = path.basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/g, "");
	return raw || "new-project";
}

function addMarker(markers: Map<string, Set<string>>, root: string, marker: string): void {
	let values = markers.get(root);
	if (!values) {
		values = new Set();
		markers.set(root, values);
	}
	values.add(marker);
}

function candidateRoots(
	added: Set<string>,
	current: Set<string>,
	baseline: Set<string>,
): Map<string, Set<string>> {
	const markers = new Map<string, Set<string>>();
	for (const relativePath of added) {
		const parts = relativePath.split("/").filter(Boolean);
		if (!parts.length) continue;
		for (let index = 0; index < parts.length; index++) {
			const name = parts[index]!;
			if (PROJECT_MARKERS.has(name) && index === parts.length - 1) {
				addMarker(markers, parts.slice(0, index).join("/"), name);
			}
			if (name === ".git") addMarker(markers, parts.slice(0, index).join("/"), ".git/");
			if (name === CODE_ROOT_MARKER && index < parts.length - 1 && isCodeFile(relativePath)) {
				const root = parts.slice(0, index).join("/");
				const codeFiles = [...current].filter(candidate => {
					const candidateParts = candidate.split("/");
					return candidateParts.length > index + 1 && candidateParts[index] === CODE_ROOT_MARKER &&
						candidateParts.slice(0, index).join("/") === root && isCodeFile(candidate);
				});
				if (codeFiles.length > 5) addMarker(markers, root, "src/");
			}
		}
	}
	for (const root of markers.keys()) {
		const markerFiles = [...markers.get(root)!].filter(marker => marker !== ".git/" && marker !== "src/");
		if (markerFiles.some(marker => baseline.has(root ? `${root}/${marker}` : marker))) {
			for (const marker of markerFiles) {
				if (baseline.has(root ? `${root}/${marker}` : marker)) markers.get(root)!.delete(marker);
			}
		}
		if (markers.get(root)!.size === 0) markers.delete(root);
	}
	return markers;
}

export class DriftTracker {
	readonly #stateFile: string;
	readonly #statusPorcelain: (cwd: string) => Promise<string>;
	readonly #suggestions = new Map<string, DriftSuggestion>();
	#baselines = new Map<string, SessionBaseline>();
	#mutedRoots = new Map<string, Set<string>>();
	#loaded: Promise<void> | undefined;
	#writeQueue: Promise<void> = Promise.resolve();

	constructor(stateDir: string, options: DriftOptions = {}) {
		this.#stateFile = path.join(stateDir, "safety", DRIFT_STATE_FILE);
		this.#statusPorcelain = options.statusPorcelain ?? readStatusPorcelain;
	}

	async captureSessionBaseline(sessionId: string, cwd: string): Promise<void> {
		await this.#load();
		const root = path.resolve(cwd);
		if (this.#baselines.get(sessionId)?.root === root) return;
		const files = await snapshotPaths(root);
		const repository = vcs.git(root);
		const prefix = repository?.prefixOf(root) ?? "";
		const status = parsePorcelainPaths(await this.#statusPorcelain(root));
		this.#baselines.set(sessionId, { root, files: [...files], status: prefixPaths(status, prefix) });
		this.#mutedRoots.delete(sessionId);
		await this.#save();
	}

	async detect(sessionId: string, cwd: string, workspaceKind: WorkspaceKind): Promise<DriftSuggestion | null> {
		this.#suggestions.forEach((suggestion, id) => {
			if (suggestion.sessionId === sessionId) this.#suggestions.delete(id);
		});
		if (workspaceKind !== "knowledge") return null;
		await this.#load();
		const root = path.resolve(cwd);
		const baseline = this.#baselines.get(sessionId);
		if (!baseline || baseline.root !== root) return null;
		const [currentFiles, currentStatusText] = await Promise.all([
			snapshotPaths(root),
			this.#statusPorcelain(root),
		]);
		const repository = vcs.git(root);
		const prefix = repository?.prefixOf(root) ?? "";
		const currentStatus = prefixPaths(parsePorcelainPaths(currentStatusText), prefix);
		const previousFiles = new Set(baseline.files);
		const previousStatus = new Set(baseline.status);
		const added = new Set<string>();
		for (const file of currentFiles) if (!previousFiles.has(file)) added.add(normalizedRelative(file));
		for (const file of currentStatus) if (!previousStatus.has(file)) added.add(normalizedRelative(file));
		if (!added.size) return null;

		const markersByRoot = candidateRoots(added, new Set([...currentFiles].map(normalizedRelative)), previousFiles);
		const muted = this.#mutedRoots.get(sessionId) ?? new Set<string>();
		for (const [relativeRoot, markers] of [...markersByRoot].sort(([left], [right]) => left.localeCompare(right))) {
			if (muted.has(relativeRoot)) continue;
			const sourceRoot = path.resolve(root, relativeRoot || ".");
			try {
				const scan = await scanMoveFiles(sourceRoot);
				const suggestion: DriftSuggestion = {
					id: `${sessionId}:${relativeRoot || "."}`,
					sessionId,
					sourceRoot,
					markers: [...markers].sort(),
					suggestedSlug: slugFromRoot(sourceRoot),
					files: scan.files.length,
					bytes: scan.bytes,
					excluded: scan.excluded,
				};
				this.#suggestions.set(suggestion.id, suggestion);
				return suggestion;
			} catch (error) {
				if (error instanceof Error && error.name === "MoveFileError") continue;
				throw error;
			}
		}
		return null;
	}

	getSuggestion(sessionId: string, suggestionId: string): DriftSuggestion | undefined {
		const suggestion = this.#suggestions.get(suggestionId);
		return suggestion?.sessionId === sessionId ? suggestion : undefined;
	}
	findSuggestion(suggestionId: string): DriftSuggestion | undefined {
		return this.#suggestions.get(suggestionId);
	}

	async dismiss(sessionId: string, suggestionId: string): Promise<void> {
		const suggestion = this.getSuggestion(sessionId, suggestionId);
		if (!suggestion) throw new Error("drift suggestion not found");
		await this.#mute(sessionId, path.relative((await this.#baseline(sessionId)).root, suggestion.sourceRoot));
	}

	async markMoved(sessionId: string, sourceRoot: string): Promise<void> {
		const baseline = await this.#baseline(sessionId);
		await this.#mute(sessionId, path.relative(baseline.root, sourceRoot));
	}

	async #baseline(sessionId: string): Promise<SessionBaseline> {
		await this.#load();
		const baseline = this.#baselines.get(sessionId);
		if (!baseline) throw new Error("session drift baseline not found");
		return baseline;
	}

	async #mute(sessionId: string, relativeRoot: string): Promise<void> {
		await this.#load();
		const roots = this.#mutedRoots.get(sessionId) ?? new Set<string>();
		roots.add(normalizedRelative(relativeRoot) || ".");
		this.#mutedRoots.set(sessionId, roots);
		await this.#save();
	}

	async #load(): Promise<void> {
		if (!this.#loaded) this.#loaded = this.#readState();
		await this.#loaded;
	}

	async #readState(): Promise<void> {
		let text: string;
		try {
			text = await Bun.file(this.#stateFile).text();
		} catch (error) {
			if (isEnoent(error)) return;
			throw error;
		}
		const parsed = JSON.parse(text) as Partial<DriftSnapshot>;
		if (Array.isArray(parsed.baselines)) {
			for (const pair of parsed.baselines) {
				if (Array.isArray(pair) && typeof pair[0] === "string" && pair[1] && typeof pair[1].root === "string" &&
					Array.isArray(pair[1].files) && Array.isArray(pair[1].status)) {
					this.#baselines.set(pair[0], pair[1]);
				}
			}
		}
		if (Array.isArray(parsed.mutedRoots)) {
			for (const pair of parsed.mutedRoots) {
				if (Array.isArray(pair) && typeof pair[0] === "string" && Array.isArray(pair[1])) {
					this.#mutedRoots.set(pair[0], new Set(pair[1].filter(item => typeof item === "string")));
				}
			}
		}
	}

	async #save(): Promise<void> {
		const previous = this.#writeQueue;
		const release = Promise.withResolvers<void>();
		this.#writeQueue = previous.then(() => release.promise);
		await previous;
		try {
			await fs.mkdir(path.dirname(this.#stateFile), { recursive: true, mode: 0o700 });
			const temporary = `${this.#stateFile}.${crypto.randomUUID()}.tmp`;
			const snapshot: DriftSnapshot = {
				baselines: [...this.#baselines],
				mutedRoots: [...this.#mutedRoots].map(([id, roots]) => [id, [...roots]]),
			};
			await fs.writeFile(temporary, JSON.stringify(snapshot), { encoding: "utf8", mode: 0o600, flag: "wx" });
			await fs.rename(temporary, this.#stateFile);
		} finally {
			release.resolve();
		}
	}
}
