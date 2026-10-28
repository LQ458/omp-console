/**
 * The daemon against the real session-host worker (scripted stub provider, isolated config root, no network):
 * the wire between the two packages, which the fake worker cannot prove.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { CatalogResponse, FileSuggestionsResponse, ListSessionsResponse, SessionSummary, SetAgentModelResponse, SpawnAgentResponse } from "@omp-console/protocol";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentEvent } from "../src/supervisor";
import { startTestDaemon, stopTestDaemons } from "./harness";
import { makeTmp } from "./helpers";

const SESSION_HOST_MAIN = path.resolve(import.meta.dir, "../../session-host/src/main.ts");
const STUB_PROVIDER = path.resolve(import.meta.dir, "../../session-host/test/fixtures/stub-provider.ts");

const cleanup: string[] = [];
afterEach(async () => {
	await stopTestDaemons();
	for (const target of cleanup.splice(0)) fs.rmSync(target, { recursive: true, force: true });
});

describe("daemon with a real worker", () => {
	it("serves the catalog, runs a command, spawns an agent with lifecycle events, changes thinking and suggests files", async () => {
		const agentDir = makeTmp("deck-real-agent-");
		fs.mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
		fs.symlinkSync(STUB_PROVIDER, path.join(agentDir, "extensions", "stub-provider.ts"));
		fs.mkdirSync(path.join(agentDir, "commands"), { recursive: true });
		fs.writeFileSync(path.join(agentDir, "commands", "realhello.md"), "---\ndescription: Planted for the real-worker test\n---\nhello $ARGUMENTS\n");
		const configDirName = `.omp-console-test-real-${path.basename(agentDir)}`;
		cleanup.push(agentDir, path.join(os.homedir(), configDirName));
		const cwd = makeTmp("omp-console-real-project-");
		cleanup.push(cwd);
		fs.mkdirSync(path.join(cwd, "src"));
		fs.writeFileSync(path.join(cwd, "src", "findable.ts"), "x");

		const events: Array<{ sessionId: string; event: AgentEvent }> = [];
		const t = await startTestDaemon({
			agentDir,
			workerCmd: [process.execPath, SESSION_HOST_MAIN],
			workerEnv: { PI_CONFIG_DIR: configDirName },
			readyTimeoutMs: 60_000,
			onAgentEvent: (sessionId, event) => events.push({ sessionId, event }),
		});
		const created = await t.post("/api/sessions", { cwd, model: "stub/stub-model" });
		expect(created.status).toBe(201);
		const session = (await created.json()) as SessionSummary;

		const catalog = (await (await t.get(`/api/sessions/${session.id}/catalog`)).json()) as CatalogResponse;
		expect(catalog.commands.find(command => command.name === "realhello")).toMatchObject({ source: "user", remote: true });
		expect(catalog.commands.find(command => command.name === "tree")).toMatchObject({ remote: false, deckControl: "tree" });
		expect(catalog.profiles.some(profile => profile.name === "task")).toBe(true);

		const command = await t.post(`/api/sessions/${session.id}/command`, { text: "/rename Real Worker Title" });
		expect(command.status).toBe(202);
		expect((await t.post(`/api/sessions/${session.id}/command`, { text: "/tree" })).status).toBe(400);
		const deadline = Date.now() + 5000;
		let title: string | undefined;
		while (Date.now() < deadline && title !== "Real Worker Title") {
			const live = ((await (await t.get("/api/sessions")).json()) as ListSessionsResponse).live.find(row => row.id === session.id);
			title = live?.title;
			if (title !== "Real Worker Title") await Bun.sleep(25);
		}
		expect(title).toBe("Real Worker Title");

		const thinking = await t.post(`/api/sessions/${session.id}/agents/Main/thinking`, { level: "low" });
		expect(thinking.status).toBe(200);
		expect(((await thinking.json()) as SetAgentModelResponse).agentId).toBe("Main");
		expect((await t.post(`/api/sessions/${session.id}/agents/Nobody/thinking`, { level: "low" })).status).toBe(404);

		const files = (await (await t.get(`/api/sessions/${session.id}/files?q=findable`)).json()) as FileSuggestionsResponse;
		expect(files.items).toContainEqual({ path: "src/findable.ts", kind: "file" });

		const spawned = await t.post(`/api/sessions/${session.id}/agents`, { profile: "task", task: "SUBWORK: go", name: "RealProbe" });
		expect(spawned.status).toBe(202);
		const { agentId } = (await spawned.json()) as SpawnAgentResponse;
		expect(agentId).toStartWith("RealProbe");
		const refused = await t.post(`/api/sessions/${session.id}/agents`, { profile: "no-such-profile", task: "x" });
		expect(refused.status).toBe(400);

		const finishedBy = Date.now() + 15_000;
		while (Date.now() < finishedBy && !events.some(entry => entry.event.agentId === agentId && entry.event.status === "completed")) await Bun.sleep(25);
		const mine = events.filter(entry => entry.event.agentId === agentId);
		expect(mine.map(entry => entry.event.status)).toEqual(["started", "completed"]);
		expect(mine.every(entry => entry.sessionId === session.id && entry.event.profile === "task")).toBe(true);
		expect(mine[1]?.event.summary).toContain("sub-done");
	}, 120_000);
});
