import type { DriftSuggestion } from "@omp-console/protocol";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export const MAX_MOVE_FILES = 20_000;
export const MAX_MOVE_BYTES = 200 * 1024 * 1024;

const DEPENDENCY_DIRS = new Set([".git", "node_modules", ".venv", "target", "dist"]);
const CODE_EXTENSIONS = new Set([
	".c", ".cc", ".cpp", ".cs", ".go", ".h", ".hpp", ".java", ".js", ".jsx", ".kt", ".m", ".mm",
	".php", ".py", ".rb", ".rs", ".scala", ".sh", ".swift", ".ts", ".tsx", ".vue", ".zig",
]);
const MAX_EXCLUDED_FILES = 20_000;

export interface CopyFile {
	path: string;
	size: number;	dev: bigint;	ino: bigint;	mode: number;	mtimeMs: number;
}

export interface MoveFileScan {
	files: CopyFile[];
	bytes: number;
	excluded: DriftSuggestion["excluded"];
}

export class MoveFileError extends Error {
	constructor(message: string, readonly code: "bad-request" | "not-found" | "conflict" | "internal" = "bad-request") {
		super(message);
		this.name = "MoveFileError";
	}
}

export function isInside(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export async function assertNoSymlinkPath(target: string, allowMissingTail = false): Promise<void> {
	const absolute = path.resolve(target);
	const { root } = path.parse(absolute);
	let current = root;
	let missing = false;
	for (const segment of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
		current = path.join(current, segment);
		if (missing) continue;
		try {
			if ((await fs.lstat(current)).isSymbolicLink()) {
				throw new MoveFileError(`symlink path component is not allowed: ${current}`, "bad-request");
			}
		} catch (error) {
			if (allowMissingTail && isEnoent(error)) {
				missing = true;
				continue;
			}
			throw error;
		}
	}
}

export function isEnoent(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export function isSecretName(name: string): boolean {
	const lower = name.toLowerCase();
	return lower.startsWith(".env") || lower.endsWith(".pem") || lower.endsWith(".key") || lower.startsWith("id_") || lower.includes("credentials");
}

function exclude(excluded: MoveFileScan["excluded"], relative: string, reason: MoveFileScan["excluded"][number]["reason"]): void {
	if (excluded.length >= MAX_EXCLUDED_FILES) throw new MoveFileError("source has too many excluded entries to preview");
	excluded.push({ path: relative || ".", reason });
}

export async function scanMoveFiles(root: string): Promise<MoveFileScan> {
	const sourceRoot = path.resolve(root);
	await assertNoSymlinkPath(sourceRoot);
	const rootStat = await fs.lstat(sourceRoot);
	if (!rootStat.isDirectory()) throw new MoveFileError("source root must be a directory", "bad-request");

	const files: CopyFile[] = [];
	const excluded: MoveFileScan["excluded"] = [];
	let bytes = 0;
	let seen = 0;
	const visit = async (directory: string, relativeDir: string): Promise<void> => {
		const entries = await fs.readdir(directory, { withFileTypes: true });
		entries.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			if (++seen > MAX_MOVE_FILES * 8) throw new MoveFileError("source has too many filesystem entries to preview");
			const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
			if (isSecretName(entry.name)) {
				exclude(excluded, relative, "secret");
				continue;
			}
			if (entry.isSymbolicLink()) {
				exclude(excluded, relative, "special-file");
				continue;
			}
			if (entry.isDirectory()) {
				if (DEPENDENCY_DIRS.has(entry.name)) {
					exclude(excluded, relative, "dependency-dir");
					continue;
				}
				const child = path.join(directory, entry.name);
				await assertNoSymlinkPath(child);
				await visit(child, relative);
				continue;
			}

			const absolute = path.join(directory, entry.name);
			await assertNoSymlinkPath(absolute);
			const stat = await fs.lstat(absolute, { bigint: true });
			if (!stat.isFile()) {
				exclude(excluded, relative, "special-file");
				continue;
			}
			if (stat.nlink > 1n) {
				exclude(excluded, relative, "hardlink");
				continue;
			}
			const size = Number(stat.size);
			if (!Number.isSafeInteger(size) || size < 0 || size > MAX_MOVE_BYTES || files.length >= MAX_MOVE_FILES || bytes + size > MAX_MOVE_BYTES) {
				exclude(excluded, relative, "too-large");
				continue;
			}
			files.push({ path: relative, size, dev: stat.dev, ino: stat.ino, mode: Number(stat.mode), mtimeMs: Number(stat.mtimeMs) });
			bytes += size;
		}
	};
	await visit(sourceRoot, "");
	return { files, bytes, excluded };
}

export async function snapshotPaths(root: string, options: { includeDependencyDirs?: boolean } = {}): Promise<Set<string>> {
	const sourceRoot = path.resolve(root);
	const paths = new Set<string>();
	const visit = async (directory: string, relativeDir: string): Promise<void> => {
		await assertNoSymlinkPath(directory);
		const before = await fs.lstat(directory, { bigint: true });
		if (!before.isDirectory()) throw new MoveFileError("source path contains a non-directory", "bad-request");
		const entries = await fs.readdir(directory, { withFileTypes: true });
		const after = await fs.lstat(directory, { bigint: true });
		if (after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino) {
			throw new MoveFileError("directory changed while taking a filesystem snapshot", "conflict");
		}
		for (const entry of entries) {
			const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
			paths.add(relative);
			if (entry.isSymbolicLink() || !entry.isDirectory() || entry.name === ".git") continue;
			if (!options.includeDependencyDirs && DEPENDENCY_DIRS.has(entry.name)) continue;
			await visit(path.join(directory, entry.name), relative);
		}
	};
	await visit(sourceRoot, "");
	return paths;
}
export function isCodeFile(relativePath: string): boolean {
	return CODE_EXTENSIONS.has(path.extname(relativePath).toLowerCase());
}

