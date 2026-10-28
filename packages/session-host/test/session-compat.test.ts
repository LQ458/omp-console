import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Fixture, newRoom, snapshotText, waitUntil } from "./harness";

let fixture: Fixture | undefined;
afterEach(async () => {
	await fixture?.dispose();
	fixture = undefined;
});

async function findSessionFile(directory: string): Promise<string | undefined> {
	for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
		const candidate = path.join(directory, entry.name);
		if (entry.isFile() && entry.name.endsWith(".jsonl")) return candidate;
		if (entry.isDirectory()) {
			const nested = await findSessionFile(candidate);
			if (nested) return nested;
		}
	}
	return undefined;
}

describe("terminal session compatibility", () => {
	test("console forks a terminal omp 18.13.2 session without changing its source", async () => {
		fixture = new Fixture();
		const prompt = "terminal-session-18.13.2-marker";
		const sessionDir = path.join(fixture.root, "terminal-sessions");
		const moduleEntry = fileURLToPath(import.meta.resolve("@oh-my-pi/pi-coding-agent"));
		const packageRoot = path.resolve(path.dirname(moduleEntry), "..");
		const cli = path.join(packageRoot, "dist", "cli.js");
		const env: Record<string, string | undefined> = {
			...process.env,
			PI_CODING_AGENT_DIR: fixture.agentDir,
			PI_CONFIG_DIR: fixture.configDirName,
		};
		delete env.PI_CONFIG_FILES;
		delete env.OMP_CONSOLE_ROOM_KEY;
		delete env.OMP_CONSOLE_WRITE_TOKEN;
		delete env.OMP_AUTH_BROKER_URL;
		delete env.OMP_AUTH_BROKER_TOKEN;

		const terminal = Bun.spawn(
			[
				process.execPath,
				cli,
				"--cwd",
				fixture.cwd,
				"--model",
				"stub/stub-model",
				"--session-dir",
				sessionDir,
				"--no-title",
				"--no-tools",
				"--print",
				prompt,
			],
			{ cwd: fixture.cwd, env, stdout: "pipe", stderr: "pipe" },
		);
		const [exitCode, stdout, stderr] = await Promise.all([
			terminal.exited,
			new Response(terminal.stdout).text(),
			new Response(terminal.stderr).text(),
		]);
		expect(exitCode, `${stdout}\n${stderr}`).toBe(0);

		const sourceFile = await findSessionFile(sessionDir);
		expect(sourceFile).toBeDefined();
		if (!sourceFile) throw new Error("terminal omp did not write a session file");
		const sourceBefore = await fs.readFile(sourceFile, "utf8");
		expect(sourceBefore).toContain(`echo:${prompt}`);

		const room = newRoom();
		const worker = fixture.spawn(room, ["--fork", sourceFile]);
		const ready = await worker.ready();
		expect(ready.sessionFile).not.toBe(sourceFile);
		const guest = fixture.guest(room);
		await waitUntil("forked terminal transcript on guest", () => snapshotText(guest.getSnapshot()).includes(`echo:${prompt}`));
		expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceBefore);
	}, 90_000);
});
