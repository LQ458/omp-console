/**
 * Request-style worker commands (catalog, run-command, spawn-agent, set-agent-thinking) against a real worker
 * process: scripted stub provider, isolated config root, no network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CatalogResponse, WorkerAbortResult, WorkerModelResult, WorkerRequestResult } from "@omp-console/protocol";
import { decodeCommand } from "../src/decode";
import { composeAssignment, formatMention, SPAWN_RESULT_MESSAGE_TYPE } from "../src/spawn-agent";
import { Fixture, newRoom, sleep, snapshotText, waitUntil, type WorkerProcess } from "./harness";

let fixture: Fixture | undefined;
afterEach(async () => {
	await fixture?.dispose();
	fixture = undefined;
});

function plant(f: Fixture, relative: string, content: string): void {
	const file = path.join(f.agentDir, relative);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

function plantExtras(f: Fixture): void {
	plant(f, "commands/ompconsolehello.md", "---\ndescription: Greets someone for omp console tests\nargument-hint: <who>\n---\nSay hello to $ARGUMENTS\n");
	plant(f, "skills/omp-console-skill/SKILL.md", "---\nname: omp-console-skill\ndescription: A skill planted by the omp console tests\n---\nDo the omp console thing.\n");
	// omp's agent discovery follows the config root (`PI_CONFIG_DIR`), not `PI_CODING_AGENT_DIR`, unlike commands and skills.
	const profile = path.join(os.homedir(), f.configDirName, "agent", "agents", "omp-console-probe.md");
	fs.mkdirSync(path.dirname(profile), { recursive: true });
	fs.writeFileSync(
		profile,
		"---\nname: omp-console-probe\ndescription: Probe profile planted by the omp console tests\ntools: read, grep\nspawns: scout\nthinking: low\n---\nYou are a probe.\n",
	);
}

async function catalogOf(worker: WorkerProcess, id = "cat"): Promise<CatalogResponse> {
	const reply = await worker.request<WorkerRequestResult>({ t: "catalog", id });
	if (reply.t !== "catalog") throw new Error(`expected a catalog, got ${JSON.stringify(reply)}`);
	return reply.catalog;
}

const errorOf = (reply: WorkerRequestResult) => (reply.t === "request-error" ? reply : undefined);
const stateLines = (worker: WorkerProcess) =>
	worker.lines.filter((line): line is Extract<typeof line, { t: "state" }> => line.t === "state");
const agentLines = (worker: WorkerProcess) =>
	worker.lines.filter((line): line is Extract<typeof line, { t: "agent" }> => line.t === "agent");

describe("catalog", () => {
	test("is built from the live registries: planted command, skill and profile appear; remote follows the text-mode handler", async () => {
		fixture = new Fixture();
		plantExtras(fixture);
		const worker = fixture.spawn(newRoom());
		await worker.ready();
		const catalog = await catalogOf(worker);

		const hello = catalog.commands.find(command => command.name === "ompconsolehello");
		expect(hello).toMatchObject({ source: "user", remote: true, description: "Greets someone for omp console tests", usage: "<who>" });
		expect(catalog.commands.find(command => command.name === "skill:omp-console-skill")).toMatchObject({ source: "skill", remote: true });
		expect(catalog.skills.find(skill => skill.name === "omp-console-skill")?.description).toBe("A skill planted by the omp console tests");

		const probe = catalog.profiles.find(profile => profile.name === "omp-console-probe");
		expect(probe).toMatchObject({ source: "user", tools: ["read", "grep"], thinking: "low", description: "Probe profile planted by the omp console tests" });
		expect(probe?.file).toEndWith(path.join("agents", "omp-console-probe.md"));
		expect(catalog.profiles.find(profile => profile.name === "task")?.source).toBe("bundled");

		// One command that has a text-mode handler, one that only exists in the TUI.
		expect(catalog.commands.find(command => command.name === "compact")).toMatchObject({ source: "builtin", remote: true });
		expect(catalog.commands.find(command => command.name === "compact")?.usage).toContain("soft");
		const tree = catalog.commands.find(command => command.name === "tree");
		expect(tree).toMatchObject({ source: "builtin", remote: false, deckControl: "tree" });
		expect(catalog.commands.find(command => command.name === "compact")?.deckControl).toBeUndefined();
		expect(catalog.commands.find(command => command.name === "model")?.aliases).toContain("models");
		expect(catalog.tools.map(tool => tool.name)).toContain("bash");
		expect(catalog.mcp).toEqual([]);
		expect(catalog.generatedAt).toBeGreaterThan(0);
	}, 90_000);

	test("is cached for 10 s, then a command added under the agent dir shows up without restarting the worker", async () => {
		fixture = new Fixture();
		const worker = fixture.spawn(newRoom());
		await worker.ready();
		const first = await catalogOf(worker, "c1");
		plant(fixture, "commands/latecomer.md", "---\ndescription: Added after the worker started\n---\nlate\n");
		const cached = await catalogOf(worker, "c2");
		expect(cached.generatedAt).toBe(first.generatedAt);
		expect(cached.commands.some(command => command.name === "latecomer")).toBe(false);

		await sleep(10_200);
		const fresh = await catalogOf(worker, "c3");
		expect(fresh.generatedAt).toBeGreaterThan(first.generatedAt);
		expect(fresh.commands.find(command => command.name === "latecomer")).toMatchObject({ source: "user", remote: true });
	}, 90_000);
});

describe("run-command", () => {
	test("a remote built-in changes the session, a file command expands into a prompt, TUI-only and unknown commands are refused", async () => {
		fixture = new Fixture();
		plantExtras(fixture);
		const room = newRoom();
		const worker = fixture.spawn(room);
		await worker.ready();

		const renamed = await worker.request<WorkerRequestResult>({ t: "run-command", id: "r1", text: "/rename Deck Title" });
		expect(renamed).toEqual({ t: "accepted", id: "r1" });
		await waitUntil("state line with the new title", () => stateLines(worker).find(line => line.title === "Deck Title"));

		const guest = fixture.guest(room);
		await waitUntil("guest live", () => guest.getSnapshot().phase === "live" && guest.getSnapshot().state);
		const hello = await worker.request<WorkerRequestResult>({ t: "run-command", id: "r2", text: "/ompconsolehello world" });
		expect(hello).toEqual({ t: "accepted", id: "r2" });
		await waitUntil("expanded file command reaches the model", () => snapshotText(guest.getSnapshot()).includes("echo:Say hello to world"));

		const tui = errorOf(await worker.request<WorkerRequestResult>({ t: "run-command", id: "r3", text: "/tree" }));
		expect(tui).toMatchObject({ code: "bad-request" });
		expect(tui?.message).toContain("terminal UI");
		const unknown = errorOf(await worker.request<WorkerRequestResult>({ t: "run-command", id: "r4", text: "/no-such-command now" }));
		expect(unknown).toMatchObject({ code: "bad-request" });
		const notSlash = errorOf(await worker.request<WorkerRequestResult>({ t: "run-command", id: "r5", text: "just text" }));
		expect(notSlash).toMatchObject({ code: "bad-request" });
		// Refused commands never became prompts: the model saw nothing for them.
		expect(snapshotText(guest.getSnapshot())).not.toContain("no-such-command");
	}, 90_000);

	test("a command that needs an idle session is refused with conflict while a turn streams", async () => {
		fixture = new Fixture();
		const room = newRoom();
		const worker = fixture.spawn(room);
		await worker.ready();
		const guest = fixture.guest(room);
		await waitUntil("guest live", () => guest.getSnapshot().phase === "live" && guest.getSnapshot().state);
		guest.sendPrompt("SLOW:keep going");
		await waitUntil("streaming state", () => stateLines(worker).find(line => line.state === "streaming"));

		const busy = errorOf(await worker.request<WorkerRequestResult>({ t: "run-command", id: "busy", text: "/rename Busy" }));
		expect(busy).toMatchObject({ code: "conflict" });
		expect(stateLines(worker).some(line => line.title === "Busy")).toBe(false);

		const aborted = await worker.request<WorkerAbortResult>({ t: "abort", id: "stop-it" });
		expect(aborted.aborted).toBe(true);
		await waitUntil("idle again", () => stateLines(worker).at(-1)?.state === "idle");
		const after = await worker.request<WorkerRequestResult>({ t: "run-command", id: "after", text: "/rename After" });
		expect(after.t).toBe("accepted");
	}, 90_000);
});

describe("spawn-agent", () => {
	test("replies as soon as the agent is registered, reports lifecycle lines, and posts the result without waking the main agent", async () => {
		fixture = new Fixture();
		const room = newRoom();
		const worker = fixture.spawn(room);
		await worker.ready();
		const guest = fixture.guest(room);
		await waitUntil("guest live", () => guest.getSnapshot().phase === "live" && guest.getSnapshot().state);

		const startedAt = Date.now();
		const reply = await worker.request<WorkerRequestResult>({
			t: "spawn-agent",
			id: "s1",
			request: { profile: "task", task: "SUBWORK: report done", name: "DeckProbe" },
		});
		expect(reply.t).toBe("spawned");
		const agentId = reply.t === "spawned" ? reply.agentId : "";
		expect(agentId).toStartWith("DeckProbe");
		// The stub subagent needs 1.5 s to answer; the reply must not have waited for it.
		expect(Date.now() - startedAt).toBeLessThan(1400);
		expect(agentLines(worker).some(line => line.status === "completed")).toBe(false);

		const done = await waitUntil("completed lifecycle line", () =>
			agentLines(worker).find(line => line.agentId === agentId && line.status === "completed"),
		);
		expect(done).toMatchObject({ profile: "task", parentId: "Main" });
		expect(done.summary).toContain("sub-done");
		const started = agentLines(worker).find(line => line.agentId === agentId && line.status === "started");
		expect(started).toMatchObject({ profile: "task", parentId: "Main" });
		expect(agentLines(worker).indexOf(started!)).toBeLessThan(agentLines(worker).indexOf(done));

		// The result is a visible transcript entry carrying the agent name, profile and the start of its answer.
		const text = await waitUntil("result message on the guest", () => {
			const snapshot = snapshotText(guest.getSnapshot());
			return snapshot.includes(SPAWN_RESULT_MESSAGE_TYPE) ? snapshot : undefined;
		});
		expect(text).toContain(`Agent ${agentId} (task) completed.`);
		expect(text).toContain("sub-done");

		// ...and the main agent was never started: its transcript holds no assistant reply and no async-result
		// follow-up (what the task tool would have delivered, and what wakes the owning session).
		await sleep(800);
		const kinds = (guest.getSnapshot().entries as ReadonlyArray<{ type: string; customType?: string; message?: { role?: string } }>).map(
			entry => `${entry.type}:${entry.customType ?? entry.message?.role ?? ""}`,
		);
		expect(kinds).toContain(`custom_message:${SPAWN_RESULT_MESSAGE_TYPE}`);
		expect(kinds.filter(kind => kind.startsWith("message:assistant"))).toHaveLength(0);
		expect(kinds).not.toContain("custom_message:async-result");
	}, 90_000);

	test("a subagent the main model spawns reports the same lifecycle lines, scoped to its parent", async () => {
		fixture = new Fixture();
		const room = newRoom();
		const worker = fixture.spawn(room);
		await worker.ready();
		const guest = fixture.guest(room);
		await waitUntil("guest live", () => guest.getSnapshot().phase === "live" && guest.getSnapshot().state);
		guest.sendPrompt("TASK:go");
		const done = await waitUntil("completed line for the model-issued spawn", () =>
			agentLines(worker).find(line => line.agentId === "Probe" && line.status === "completed"),
		);
		expect(done).toMatchObject({ profile: "task", parentId: "Main", summary: "sub-done" });
		expect(agentLines(worker).find(line => line.agentId === "Probe")).toMatchObject({ status: "started", parentId: "Main" });
	}, 90_000);

	test("refuses an unknown profile (bad-request) and a profile the settings disable (conflict)", async () => {
		fixture = new Fixture({ configYaml: "task:\n  disabledAgents:\n    - reviewer\n" });
		const worker = fixture.spawn(newRoom());
		await worker.ready();

		const unknown = errorOf(
			await worker.request<WorkerRequestResult>({ t: "spawn-agent", id: "u1", request: { profile: "no-such-profile", task: "x" } }),
		);
		expect(unknown).toMatchObject({ code: "bad-request" });
		expect(unknown?.message).toContain("no-such-profile");
		const empty = errorOf(await worker.request<WorkerRequestResult>({ t: "spawn-agent", id: "u2", request: { profile: "task", task: "   " } }));
		expect(empty).toMatchObject({ code: "bad-request" });
		const disabled = errorOf(
			await worker.request<WorkerRequestResult>({ t: "spawn-agent", id: "u3", request: { profile: "reviewer", task: "review it" } }),
		);
		expect(disabled).toMatchObject({ code: "conflict" });
		expect(agentLines(worker)).toHaveLength(0);
		const catalog = await catalogOf(worker);
		expect(catalog.profiles.some(profile => profile.name === "reviewer")).toBe(false);
	}, 90_000);

	test("files travel as @path mentions, quoted when the path contains whitespace", () => {
		expect(composeAssignment("do it", ["src/a.ts", "docs/with space.md"])).toBe('@src/a.ts\n@"docs/with space.md"\n\ndo it');
		expect(composeAssignment("do it", undefined)).toBe("do it");
		expect(formatMention('a "b" c')).toBe(`@'a "b" c'`);
		expect(() => formatMention(`a b'c"d`)).toThrow("whitespace and both quote kinds");
		expect(() => formatMention("two\nlines")).toThrow();
	});
});

describe("set-agent-thinking", () => {
	test("changes the thinking level of the root and of a running subagent, session-only, and refuses what it cannot apply", async () => {
		fixture = new Fixture();
		const worker = fixture.spawn(newRoom(), ["--model", "stub/stub-model-r"]);
		await worker.ready();

		const set = await worker.request<WorkerModelResult>({ t: "set-agent-thinking", id: "t1", agentId: "Main", level: "high" });
		expect(set).toMatchObject({ t: "model-set", agentId: "Main", model: "stub/stub-model-r", thinkingLevel: "high" });
		await waitUntil("state line with the new level", () => stateLines(worker).find(line => line.thinkingLevel === "high"));

		const spawned = await worker.request<WorkerRequestResult>({
			t: "spawn-agent",
			id: "t-spawn",
			request: { profile: "task", task: "SUBWORK: think" },
		});
		const agentId = spawned.t === "spawned" ? spawned.agentId : "";
		// `spawned` is answered at registration; the subagent's live session can come a moment later on a slow machine,
		// and until then the worker correctly refuses with "has no live session". Retry only that refusal.
		let sub: WorkerModelResult | undefined;
		const subDeadline = Date.now() + 15_000;
		for (let attempt = 0; ; attempt++) {
			sub = await worker.request<WorkerModelResult>({ t: "set-agent-thinking", id: `t2-${attempt}`, agentId, level: "low" });
			const pending = sub.t === "model-error" && sub.message.includes("has no live session");
			if (!pending || Date.now() > subDeadline) break;
			await Bun.sleep(100);
		}
		expect(sub).toMatchObject({ t: "model-set", agentId, thinkingLevel: "low" });
		// The root keeps its own level: the change was scoped to the subagent.
		expect(stateLines(worker).at(-1)?.thinkingLevel).toBe("high");

		const unknownAgent = await worker.request<WorkerModelResult>({ t: "set-agent-thinking", id: "t3", agentId: "Nobody", level: "low" });
		expect(unknownAgent).toMatchObject({ t: "model-error" });
		expect((unknownAgent as Extract<WorkerModelResult, { t: "model-error" }>).message).toBe("unknown agent Nobody");
		const unknownLevel = await worker.request<WorkerModelResult>({
			t: "set-agent-thinking",
			id: "t4",
			agentId: "Main",
			level: "ludicrous" as "low",
		});
		expect(unknownLevel).toMatchObject({ t: "model-error" });
		expect(stateLines(worker).at(-1)?.thinkingLevel).toBe("high");
	}, 90_000);
});

describe("command decoding", () => {
	test("malformed request commands are not decoded (the worker logs and ignores them)", () => {
		expect(decodeCommand(JSON.stringify({ t: "spawn-agent", id: "x", request: { profile: "task" } }))).toBeUndefined();
		expect(decodeCommand(JSON.stringify({ t: "spawn-agent", id: "x", request: { profile: "task", task: "t", files: [1] } }))).toBeUndefined();
		expect(decodeCommand(JSON.stringify({ t: "run-command", id: "x" }))).toBeUndefined();
		expect(decodeCommand(JSON.stringify({ t: "catalog" }))).toBeUndefined();
		expect(decodeCommand("{not json")).toBeUndefined();
		expect(decodeCommand(JSON.stringify({ t: "catalog", id: "ok" }))).toEqual({ t: "catalog", id: "ok" });
		expect(decodeCommand(JSON.stringify({ t: "spawn-agent", id: "ok", request: { profile: "p", task: "t", isolated: true, files: ["a"] } }))).toEqual({
			t: "spawn-agent",
			id: "ok",
			request: { profile: "p", task: "t", isolated: true, files: ["a"] },
		});
	});
});
