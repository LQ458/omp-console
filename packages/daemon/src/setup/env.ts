import { refreshDirsFromEnv } from "@oh-my-pi/pi-utils/dirs";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isWindows, privateFileProblem } from "../platform";

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

/** Loads literal KEY=value lines from a private POSIX file or an ACL-protected Windows state directory. */
export async function loadStateEnvironment(stateDir: string): Promise<string[]> {
	const file = path.join(stateDir, "env");
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(file, fsConstants.O_RDONLY | (isWindows ? 0 : fsConstants.O_NOFOLLOW));
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
		const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown error";
		throw new Error(`could not open the omp-console env file safely (${code})`);
	}
	try {
		const stat = isWindows ? await fs.lstat(file) : await handle.stat();
		const problem = privateFileProblem(stat);
		if (problem !== undefined) throw new Error(`omp-console env ${problem}`);
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
