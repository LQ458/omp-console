import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { loadStateEnvironment } from "../src/setup/env";
import { makeTmp } from "./helpers";

const TEST_KEY = `OMPC_ONBOARD_ENV_${process.pid}`;
const previousValue = process.env[TEST_KEY];

afterEach(() => {
	if (previousValue === undefined) delete process.env[TEST_KEY];
	else process.env[TEST_KEY] = previousValue;
});

describe("daemon environment file", () => {
	it("loads literal values from an owned 0600 file and reports names only", async () => {
		const stateDir = makeTmp("omp-console-env-");
		await fs.writeFile(path.join(stateDir, "env"), `# local credentials\n${TEST_KEY}=literal $value with spaces\n`, { mode: 0o600 });
		await fs.chmod(path.join(stateDir, "env"), 0o600);
		expect(await loadStateEnvironment(stateDir)).toEqual([TEST_KEY]);
		expect(process.env[TEST_KEY]).toBe("literal $value with spaces");
	});

	it("ignores an absent file but rejects insecure modes and non-assignment lines", async () => {
		const missingDir = makeTmp("omp-console-env-missing-");
		expect(await loadStateEnvironment(missingDir)).toEqual([]);

		const openDir = makeTmp("omp-console-env-mode-");
		const openFile = path.join(openDir, "env");
		await fs.writeFile(openFile, `${TEST_KEY}=private`, { mode: 0o644 });
		await fs.chmod(openFile, 0o644);
		await expect(loadStateEnvironment(openDir)).rejects.toThrow("mode 0600");

		const invalidDir = makeTmp("omp-console-env-invalid-");
		await fs.writeFile(path.join(invalidDir, "env"), "export SECRET=value\n", { mode: 0o600 });
		await fs.chmod(path.join(invalidDir, "env"), 0o600);
		await expect(loadStateEnvironment(invalidDir)).rejects.toThrow("KEY=value");
	});
});

describe("daemon environment file: omp directories and line endings", () => {
	it("points the daemon's own omp agent directory at PI_CODING_AGENT_DIR from the file", async () => {
		const { getAgentDir, refreshDirsFromEnv } = await import("@oh-my-pi/pi-utils/dirs");
		const previous = process.env.PI_CODING_AGENT_DIR;
		const stateDir = makeTmp("omp-console-env-dirs-");
		const agentDir = makeTmp("omp-console-env-agent-");
		await fs.writeFile(path.join(stateDir, "env"), `PI_CODING_AGENT_DIR=${agentDir}\n`, { mode: 0o600 });
		await fs.chmod(path.join(stateDir, "env"), 0o600);
		try {
			await loadStateEnvironment(stateDir);
			expect(getAgentDir()).toBe(agentDir);
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			refreshDirsFromEnv();
		}
	});

	it("rejects CRLF line endings like the launchd wrapper does", async () => {
		const stateDir = makeTmp("omp-console-env-crlf-");
		await fs.writeFile(path.join(stateDir, "env"), `${TEST_KEY}=1\r\n`, { mode: 0o600 });
		await fs.chmod(path.join(stateDir, "env"), 0o600);
		await expect(loadStateEnvironment(stateDir)).rejects.toThrow("KEY=value");
	});
});
