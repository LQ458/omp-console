import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { listPersistedSessions, RecentSessionScanError } from "../src/recent";
import { makeTmp } from "./helpers";

const previous = process.env.OMP_CONSOLE_SESSIONS_DIR;
const locked: string[] = [];

afterEach(async () => {
	for (const directory of locked.splice(0)) await fs.chmod(directory, 0o700);
	if (previous === undefined) delete process.env.OMP_CONSOLE_SESSIONS_DIR;
	else process.env.OMP_CONSOLE_SESSIONS_DIR = previous;
});

describe("persisted session scan", () => {
	// chmod permissions do not restrict access through Windows ACLs.
	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("reports an unreadable session store instead of returning no sessions", async () => {
		const store = makeTmp("omp-console-locked-store-");
		process.env.OMP_CONSOLE_SESSIONS_DIR = store;
		await fs.chmod(store, 0o000);
		locked.push(store);
		await expect(listPersistedSessions()).rejects.toBeInstanceOf(RecentSessionScanError);
	});

	// chmod permissions do not restrict access through Windows ACLs.
	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("reports an unreadable project folder inside the store", async () => {
		const store = makeTmp("omp-console-locked-bucket-");
		const bucket = path.join(store, "--work-project--");
		await fs.mkdir(bucket);
		process.env.OMP_CONSOLE_SESSIONS_DIR = store;
		await fs.chmod(bucket, 0o000);
		locked.push(bucket);
		await expect(listPersistedSessions()).rejects.toThrow(bucket);
	});
});
