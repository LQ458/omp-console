import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface TrashOptions {
	/** The daemon state dir; its `trash/` folder takes sessions when there is no system Trash (Linux) or it refuses. */
	stateDir: string;
	/** The system Trash; default `~/.Trash` on macOS and none elsewhere. `null`: always the daemon's own folder. */
	systemTrashDir?: string | null;
	now?: () => Date;
	/** Test seam for exercising cross-device rename fallback. */
	rename?: (source: string, destination: string) => Promise<void>;
}

function stamp(date: Date): string {
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** Creates `<base>/<name>`, or `<name>-2`, `-3`, ... when taken: mkdir is atomic, so two deletes never share one. */
async function uniqueFolder(base: string, name: string): Promise<string> {
	for (let n = 1; ; n++) {
		const candidate = path.join(base, n === 1 ? name : `${name}-${n}`);
		try {
			await fs.mkdir(candidate, { mode: 0o700 });
			return candidate;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
}

/** The transcript plus omp's sibling folder of the same name (subagent transcripts, artifacts), when present. */
async function sessionParts(sessionFile: string): Promise<string[]> {
	const parts = [sessionFile];
	const folder = sessionFile.endsWith(".jsonl") ? sessionFile.slice(0, -".jsonl".length) : undefined;
	if (folder) {
		try {
			if ((await fs.lstat(folder)).isDirectory()) parts.push(folder);
		} catch {}
	}
	return parts;
}

/** Moves every part into a new folder under `base`, all or nothing. */
async function moveInto(
	base: string,
	folderName: string,
	parts: readonly string[],
	rename: (source: string, destination: string) => Promise<void>,
): Promise<string> {
	const folder = await uniqueFolder(base, folderName);
	const moved: Array<[string, string]> = [];
	try {
		for (const part of parts) {
			const target = path.join(folder, path.basename(part));
			await rename(part, target);
			moved.push([target, part]);
		}
		return folder;
	} catch (error) {
		// Never leave a session half in the Trash: put back what already moved.
		for (const [target, original] of moved.reverse()) await rename(target, original).catch(() => {});
		await fs.rmdir(folder).catch(() => {});
		throw error;
	}
}

/**
 * Moves a session's transcript and its sibling folder out of the session store, never deleting them, into one new
 * folder: `~/.Trash/omp-console session <stamp> <name>/` on macOS, else (or when the Trash refuses, e.g. another volume)
 * `<stateDir>/trash/<stamp>-<name>/`. Returns that folder.
 */
export async function moveSessionToTrash(sessionFile: string, options: TrashOptions): Promise<string> {
	const systemTrash =
		options.systemTrashDir !== undefined ? options.systemTrashDir : process.platform === "darwin" ? path.join(os.homedir(), ".Trash") : null;
	const when = stamp((options.now ?? (() => new Date()))());
	const name = path.basename(sessionFile, ".jsonl");
	const parts = await sessionParts(sessionFile);
	const rename = options.rename ?? fs.rename;
	if (systemTrash !== null) {
		try {
			return await moveInto(systemTrash, `omp-console session ${when} ${name}`, parts, rename);
		} catch {}
	}
	const own = path.join(options.stateDir, "trash");
	await fs.mkdir(own, { recursive: true, mode: 0o700 });
	try {
		return await moveInto(own, `${when}-${name}`, parts, rename);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
		// A sibling folder keeps the fallback rename on the session file's volume and avoids copying transcript data.
		const fileVolumeTrash = path.join(path.dirname(sessionFile), ".omp-console-trash");
		await fs.mkdir(fileVolumeTrash, { recursive: true, mode: 0o700 });
		return moveInto(fileVolumeTrash, `${when}-${name}`, parts, rename);
	}
}
