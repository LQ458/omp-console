import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import type { NewSessionBrowseResponse } from "@omp-console/protocol";
import { isPathWithin, isSafeDirectoryName } from "./librarian/paths";

type BrowseErrorCode = "bad-request" | "forbidden" | "not-found" | "internal";
type BrowseErrorStatus = 400 | 403 | 404 | 500;

export class NewSessionBrowseError extends Error {
	constructor(
		readonly status: BrowseErrorStatus,
		readonly code: BrowseErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "NewSessionBrowseError";
	}
}

export interface NewSessionBrowseOptions {
	homeDirectory?: string;
	projectRoots?: readonly string[];
}

const MAX_DIRECTORY_ENTRIES = 500;
const MAX_DIRECTORY_SCAN_MS = 750;

function safeWithinRoot(root: string, directory: string): boolean {
	if (!isPathWithin(root, directory)) return false;
	return path.relative(root, directory).split(path.sep).filter(Boolean).every(isSafeDirectoryName);
}

/** Windows profile folders that are hidden in Explorer but are ordinary directories here. */
const WINDOWS_HIDDEN_PROFILE_FOLDERS = new Set(["appdata"]);

function allowedRoot(directory: string, home: string, projectRoots: readonly string[]): string | undefined {
	if (isPathWithin(home, directory) && safeWithinRoot(home, directory)) return home;
	// A configured project root may itself sit in a folder the home rule hides (~/.work/proj, iCloud Drive, build/).
	return projectRoots
		.filter(root => isPathWithin(root, directory) && safeWithinRoot(root, directory))
		.sort((left, right) => right.length - left.length)[0];
}

/** Whether a request is inside an allowed root by its spelling alone; checked before the path is touched. */
function textuallyAllowed(requested: string, roots: readonly string[]): boolean {
	const target = path.resolve(requested);
	return roots.some(root => isPathWithin(path.resolve(root), target));
}

async function isLink(candidate: string): Promise<boolean> {
	try {
		return (await fs.lstat(candidate)).isSymbolicLink();
	} catch {
		return true;
	}
}

async function realDirectory(candidate: string, label: string): Promise<string> {
	try {
		const real = await fs.realpath(candidate);
		if (!(await fs.stat(real)).isDirectory()) {
			throw new NewSessionBrowseError(400, "bad-request", "Choose a folder, not a file.");
		}
		return real;
	} catch (error) {
		if (error instanceof NewSessionBrowseError) throw error;
		if (isEnoent(error)) throw new NewSessionBrowseError(404, "not-found", "That folder no longer exists.", { cause: error });
		throw new NewSessionBrowseError(500, "internal", `Couldn't list ${label}. Check the folder permissions and try again.`, { cause: error });
	}
}

async function safeDirectoryEntry(
	candidate: string,
	home: string,
	projectRoots: readonly string[],
): Promise<boolean> {
	try {
		const real = await fs.realpath(candidate);
		if (!(await fs.stat(real)).isDirectory()) return false;
		return allowedRoot(real, home, projectRoots) !== undefined;
	} catch {
		// The entry may disappear or become inaccessible while the folder is being scanned.
		return false;
	}
}

/** Lists visible child folders without following a path outside the real home or configured project roots. */
export async function browseNewSessionDirectory(
	directory: string | undefined,
	options: NewSessionBrowseOptions = {},
): Promise<NewSessionBrowseResponse> {
	const homeDirectory = options.homeDirectory ?? os.homedir();
	const requested = directory ?? homeDirectory;
	if (requested.length > 4096 || requested.includes("\0") || !path.isAbsolute(requested)) {
		throw new NewSessionBrowseError(400, "bad-request", "Choose a valid absolute folder path.");
	}

	let home: string;
	try {
		home = await fs.realpath(homeDirectory);
	} catch (error) {
		throw new NewSessionBrowseError(500, "internal", "Couldn't find your home folder.", { cause: error });
	}
	const projectRoots = (await Promise.all((options.projectRoots ?? []).map(async root => {
		try {
			const real = await fs.realpath(root);
			return (await fs.stat(real)).isDirectory() ? real : undefined;
		} catch {
			return undefined;
		}
	}))).filter((root): root is string => root !== undefined);
	// Refuse by spelling first, so a paired device cannot probe which outside paths exist (or make Windows contact a
	// \\host\share); the real-path check below still catches symlinks that lead out.
	if (!textuallyAllowed(requested, [homeDirectory, home, ...(options.projectRoots ?? []), ...projectRoots])) {
		throw new NewSessionBrowseError(403, "forbidden", "Choose a folder inside your home folder or a configured project folder.");
	}
	const current = await realDirectory(requested, "this folder");
	if (allowedRoot(current, home, projectRoots) === undefined) {
		throw new NewSessionBrowseError(403, "forbidden", "Choose a folder inside your home folder or a configured project folder.");
	}

	const parentPath = path.dirname(current);
	const parent = parentPath === current || allowedRoot(parentPath, home, projectRoots) === undefined ? undefined : parentPath;
	const entries: NewSessionBrowseResponse["entries"] = [];
	const deadline = Date.now() + MAX_DIRECTORY_SCAN_MS;
	let scanned = 0;
	let truncated = false;
	try {
		const directoryHandle = await fs.opendir(current);
		for await (const entry of directoryHandle) {
			if (Date.now() >= deadline || scanned >= MAX_DIRECTORY_ENTRIES) {
				truncated = true;
				break;
			}
			scanned++;
			if (!isSafeDirectoryName(entry.name) || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
			const candidate = path.join(current, entry.name);
			// Windows profiles hold hidden system folders and legacy junctions ("My Documents", "Application Data") that
			// point back at real folders; listing them only adds confusing duplicates. lstat, not the directory entry,
			// decides: listings flag every reparse point, including OneDrive placeholders, which are real folders.
			if (process.platform === "win32" && (WINDOWS_HIDDEN_PROFILE_FOLDERS.has(entry.name.toLowerCase()) || await isLink(candidate))) continue;
			if (await safeDirectoryEntry(candidate, home, projectRoots)) entries.push({ name: entry.name, path: candidate });
		}
	} catch (error) {
		if (isEnoent(error)) throw new NewSessionBrowseError(404, "not-found", "That folder no longer exists.", { cause: error });
		throw new NewSessionBrowseError(500, "internal", "Couldn't list this folder. Check the folder permissions and try again.", { cause: error });
	}
	entries.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) || left.name.localeCompare(right.name));

	return {
		dir: current,
		home,
		...(parent === undefined ? {} : { parent }),
		entries,
		truncated,
	};
}
