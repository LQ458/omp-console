import { refreshDirsFromEnv } from "@oh-my-pi/pi-utils/dirs";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const VARIABLE_NAME = /^[A-Z_][A-Z0-9_]*$/;

function parseAssignments(contents: string): Array<[string, string]> {
	if (contents.includes("\0")) throw new Error("env file must not contain NUL bytes");
	const values = new Map<string, string>();
	// Split on LF only, so a CRLF file is rejected here exactly as the launchd wrapper rejects it.
	for (const [index, line] of contents.split("\n").entries()) {
		if (line === "" || line.startsWith("#")) continue;
		const separator = line.indexOf("=");
		const key = separator < 0 ? "" : line.slice(0, separator);
		if (!VARIABLE_NAME.test(key) || line.includes("\r")) {
			throw new Error(`env file line ${index + 1} must be KEY=value or a comment`);
		}
		values.set(key, line.slice(separator + 1));
	}
	return [...values];
}

/** Loads only literal KEY=value lines from a private, current-user-owned state file. */
export async function loadStateEnvironment(stateDir: string): Promise<string[]> {
	const file = path.join(stateDir, "env");
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
		throw new Error("could not open the omp-console env file safely");
	}
	try {
		const stat = await handle.stat();
		const uid = process.getuid?.();
		if (!stat.isFile()) throw new Error("omp-console env must be a regular file");
		if (uid === undefined || stat.uid !== uid) throw new Error("omp-console env must be owned by the daemon user");
		if ((stat.mode & 0o7777) !== 0o600) throw new Error("omp-console env must have mode 0600");
		const assignments = parseAssignments(await handle.readFile("utf8"));
		for (const [key, value] of assignments) process.env[key] = value;
		// omp resolves its agent/config directories at import time; re-read them so PI_CODING_AGENT_DIR and
		// PI_CONFIG_DIR from this file apply to the daemon itself, not only to the workers it spawns.
		if (assignments.some(([key]) => key === "PI_CODING_AGENT_DIR" || key === "PI_CONFIG_DIR")) refreshDirsFromEnv();
		return assignments.map(([key]) => key);
	} finally {
		await handle.close();
	}
}
