import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { __resetDirsFromEnvForTests, setAgentDir } from "@oh-my-pi/pi-utils";
import { AgentModelError, setFocusedAgentModel } from "../src/agent-model";
import type { WorkerLaunch } from "../src/launch";
import type { StatusLine } from "../src/status";
import { SessionHostWorker } from "../src/worker";
import { startLocalRelay, type LocalRelay } from "./collab-web/local-relay";
import { waitUntil } from "./harness";

let root: string;
let relay: LocalRelay;
let worker: SessionHostWorker | undefined;
const lines: StatusLine[] = [];
const savedConfigDir = process.env.PI_CONFIG_DIR;
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "deck-agent-model-"));
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
	fs.mkdirSync(path.join(root, "project"), { recursive: true });
	fs.symlinkSync(
		path.resolve(import.meta.dir, "fixtures/stub-provider.ts"),
		path.join(agentDir, "extensions", "stub.ts"),
	);
	process.env.PI_CONFIG_DIR = `.omp-console-test-${path.basename(root)}`;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	setAgentDir(agentDir);
	relay = startLocalRelay(0);
	lines.length = 0;
});

afterEach(async () => {
	await worker?.stop("test over");
	worker = undefined;
	relay.stop();
	// This test runs the worker in-process, and on Windows a file in the agent folder stays open after stop() until the
	// process exits (a real worker is its own process). Windows cannot delete an open file, so these folders may stay.
	for (const folder of [root, path.join(os.homedir(), process.env.PI_CONFIG_DIR ?? ".omp-console-test-none")]) {
		try {
			fs.rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		} catch (error) {
			if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
		}
	}
	if (savedConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
	else process.env.PI_CONFIG_DIR = savedConfigDir;
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
	__resetDirsFromEnvForTests();
});

async function startWorker(toolAllowlist?: string[], agendaTools = false): Promise<SessionHostWorker> {
	const launch: WorkerLaunch & { toolAllowlist?: string[] } = {
		cwd: path.join(root, "project"),
		relay: relay.url,
		roomId: randomBytes(16).toString("base64url"),
		agendaTools,
		computerUse: false,
		roomKey: randomBytes(32),
		writeToken: randomBytes(16),
		deviceToken: randomBytes(32).toString("base64url"),
		model: "stub/stub-model",
		...(toolAllowlist === undefined ? {} : { toolAllowlist }),
	};
	worker = await SessionHostWorker.start(
		launch,
		{ emit: line => lines.push(line) },
		{ onFatal: message => lines.push({ t: "fatal", message }) },
	);
	return worker;
}

test("setFocusedAgentModel switches the live agent only, and reports the new model to the daemon", async () => {
	const started = await startWorker();
	expect(started.session.model?.id).toBe("stub-model");
	const persistedDefault = started.session.settings.getModelRole("default");

	const result = await setFocusedAgentModel(started.registry, "Main", "stub/stub-model-2");
	expect(result).toMatchObject({ agentId: "Main", model: "stub/stub-model-2" });
	expect(started.session.model?.id).toBe("stub-model-2");
	// Session-only: the user's configured default is untouched.
	expect(started.session.settings.getModelRole("default")).toBe(persistedDefault);
	await waitUntil("state line with the new model", () =>
		lines.find(line => line.t === "state" && line.model === "stub/stub-model-2"),
	);
});

test("setFocusedAgentModel refuses unknown agents and selectors nothing matches", async () => {
	const started = await startWorker();
	await expect(setFocusedAgentModel(started.registry, "Nobody", "stub/stub-model-2")).rejects.toBeInstanceOf(
		AgentModelError,
	);
	await expect(setFocusedAgentModel(started.registry, "Main", "stub/no-such-model")).rejects.toBeInstanceOf(
		AgentModelError,
	);
	expect(started.session.model?.id).toBe("stub-model");
});

test("a requested tool allowlist exposes only agenda_today and agenda_add in the worker session", async () => {
	const started = await startWorker(["agenda_today", "agenda_add"], true);
	expect(started.session.getActiveToolNames().sort()).toEqual(["agenda_add", "agenda_today"]);
});
