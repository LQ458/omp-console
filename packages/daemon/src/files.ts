/**
 * `@file` mention suggestions (spec 5.1): omp's own native fuzzy finder over the session's cwd, honouring
 * `.gitignore` and including dotfiles, with the walker cache on. Paths come back relative to the cwd (`/`
 * separators, directories end with `/`), exactly what omp's `@path` mention syntax resolves.
 */
import type { FileSuggestion } from "@omp-console/protocol";
import { fuzzyFind } from "@oh-my-pi/pi-natives";
import * as path from "node:path";
import { isWindows } from "./platform";

export const DEFAULT_FILE_LIMIT = 50;
export const MAX_FILE_LIMIT = 200;
export const MAX_FILE_QUERY_LENGTH = 512;
const FILE_SEARCH_TIMEOUT_MS = 1500;
/** An empty query lists the top level of the cwd; the finder returns the whole tree, so ask for enough to reach it. */
const TOP_LEVEL_SCAN_LIMIT = 5000;

export class FileSearchTimeoutError extends Error {
	override readonly name = "FileSearchTimeoutError";
}

/** True for a path that stays inside `cwd`: relative, no `..` segment, resolves under the cwd. */
export function isInsideCwd(cwd: string, relative: string): boolean {
	if (relative === "" || path.isAbsolute(relative) || relative.includes("\0")) return false;
	if (isWindows) {
		if (relative.split(/[\\/]/).some(segment => segment === "..")) return false;
		const root = path.resolve(cwd);
		const resolved = path.resolve(root, relative);
		const fromRoot = path.relative(root, resolved);
		return fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${path.sep}`) && !path.isAbsolute(fromRoot));
	}
	if (relative.split("/").some(segment => segment === "..")) return false;
	const resolved = path.resolve(cwd, relative);
	return resolved === cwd || resolved.startsWith(cwd.endsWith(path.sep) ? cwd : `${cwd}${path.sep}`);
}

function isTimeout(error: unknown): boolean {
	return error instanceof Error && /timed? ?out|timeout|cancel|abort/i.test(error.message);
}

export async function suggestFiles(cwd: string, query: string, limit: number): Promise<FileSuggestion[]> {
	const root = path.resolve(cwd);
	const topLevelOnly = query === "";
	let result: Awaited<ReturnType<typeof fuzzyFind>>;
	try {
		result = await fuzzyFind({
			query,
			path: root,
			gitignore: true,
			hidden: true,
			cache: true,
			maxResults: topLevelOnly ? TOP_LEVEL_SCAN_LIMIT : limit,
			timeoutMs: FILE_SEARCH_TIMEOUT_MS,
		});
	} catch (error) {
		if (isTimeout(error)) throw new FileSearchTimeoutError(`file search exceeded ${FILE_SEARCH_TIMEOUT_MS} ms`);
		throw error;
	}
	const items: FileSuggestion[] = [];
	for (const match of result.matches) {
		if (!isInsideCwd(root, match.path)) continue;
		const segments = match.path.split("/").filter(segment => segment !== "");
		if (topLevelOnly && segments.length !== 1) continue;
		const isDir = match.isDirectory;
		items.push({ path: isDir && !match.path.endsWith("/") ? `${match.path}/` : match.path, kind: isDir ? "dir" : "file" });
		if (items.length >= limit) break;
	}
	return items;
}
