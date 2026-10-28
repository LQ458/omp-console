/**
 * Daemon-facing services of a worker (ext-ui, usage samples, key points, titles, plugins, quota policy) against a
 * real worker process: scripted stub provider, isolated config root, no network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionUiState, WorkerRequestResult } from "@omp-console/protocol";
import { STUB_FAKE_JWT } from "./fixtures/stub-provider";
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

/** Profiles are discovered under the config root (`PI_CONFIG_DIR`), not the agent dir. */
function plantProfile(f: Fixture, name: string, content: string): void {
	const file = path.join(os.homedir(), f.configDirName, "agent", "agents", `${name}.md`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

async function liveGuest(f: Fixture, room: ReturnType<typeof newRoom>) {
	const guest = f.guest(room);
	await waitUntil("guest live", () => guest.getSnapshot().phase === "live" && guest.getSnapshot().state);
	return guest;
}

const stateLines = (worker: WorkerProcess) =>
	worker.lines.filter((line): line is Extract<typeof line, { t: "state" }> => line.t === "state");
const agentLines = (worker: WorkerProcess) =>
	worker.lines.filter((line): line is Extract<typeof line, { t: "agent" }> => line.t === "agent");
const titleLines = (worker: WorkerProcess) =>
	worker.lines.filter((line): line is Extract<typeof line, { t: "title" }> => line.t === "title");
const extUiLines = (worker: WorkerProcess) =>
	worker.lines.filter((line): line is Extract<typeof line, { t: "ext-ui" }> => line.t === "ext-ui");
const errorOf = (reply: WorkerRequestResult) => (reply.t === "request-error" ? reply : undefined);

const SMOL_CONFIG = "modelRoles:\n  smol: stub/stub-model\n  tiny: stub/stub-model\ntitle:\n  icons: boring\n";

const UI_PROBE = `export default function (pi) {
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus("probe", "booted");
		ctx.ui.setWidget("lines", ["alpha", "beta"]);
		ctx.ui.setWidget("omp-console:build", { kind: "progress", title: "Build", value: 3, max: 10, label: "tests" });
		ctx.ui.setWidget("omp-console:facts", [JSON.stringify({ kind: "kv", title: "Facts", rows: [{ key: "a", value: "1" }] })]);
		ctx.ui.setWidget("omp-console:broken", { kind: "progress", title: "no numbers" });
		ctx.ui.notify("probe loaded", "warning");
	});
	pi.registerCommand("probe-burst", {
		description: "Publishes many updates at once",
		handler: async (_args, ctx) => {
			for (let i = 0; i < 60; i++) ctx.ui.setStatus("probe", "tick " + i);
			ctx.ui.setStatus("other", "x");
			ctx.ui.setStatus("other", undefined);
			ctx.ui.setWidget("omp-console:build", { kind: "progress", title: "Build", value: 9, max: 10 });
			for (let i = 0; i < 25; i++) ctx.ui.notify("n" + i, "info");
		},
	});
}
`;

describe("ext-ui", () => {
	test("status, widgets, omp console panels and notifications arrive as whole-state lines; a burst costs one line", async () => {
		fixture = new Fixture();
		plant(fixture, "extensions/ui-probe.ts", UI_PROBE);
		const worker = fixture.spawn(newRoom());
		await worker.ready();

		const first = await waitUntil("ext-ui with the startup state", () => extUiLines(worker).at(-1));
		const startup: ExtensionUiState = first.state;
		expect(startup.statuses).toEqual([{ key: "probe", text: "booted" }]);
		// A string-array widget stays a widget; an `omp-console:` key with a valid descriptor (object, or JSON in a one-line
		// array) becomes a panel under the id after the prefix; an invalid descriptor is dropped altogether.
		expect(startup.widgets).toEqual([{ key: "lines", lines: ["alpha", "beta"] }]);
		expect(startup.panels).toEqual([
			{ key: "build", descriptor: { kind: "progress", title: "Build", value: 3, max: 10, label: "tests" } },
			{ key: "facts", descriptor: { kind: "kv", title: "Facts", rows: [{ key: "a", value: "1" }] } },
		]);
		expect(startup.notifications).toHaveLength(1);
		expect(startup.notifications[0]).toMatchObject({ message: "probe loaded", level: "warning" });

		const before = extUiLines(worker).length;
		const burst = await worker.request<WorkerRequestResult>({ t: "run-command", id: "burst", text: "/probe-burst" });
		expect(burst).toEqual({ t: "accepted", id: "burst" });
		await waitUntil("burst state", () => extUiLines(worker).at(-1)?.state.statuses[0]?.text === "tick 59");
		await sleep(500);
		expect(extUiLines(worker).length - before).toBeLessThanOrEqual(2);
		const last = extUiLines(worker).at(-1)!.state;
		expect(last.statuses).toEqual([{ key: "probe", text: "tick 59" }]);
		expect(last.panels.find(panel => panel.key === "build")?.descriptor).toMatchObject({ value: 9 });
		// Only the newest 20 notifications are kept, oldest first.
		expect(last.notifications).toHaveLength(20);
		expect(last.notifications.at(-1)?.message).toBe("n24");
		// 26 were published (the startup one and n0..n24), so the first six are gone.
		expect(last.notifications[0]?.message).toBe("n5");
	}, 90_000);
});

describe("usage-sample", () => {
	test("every finished model request of any agent is reported with provider, model and tokens excluding cache reads", async () => {
		fixture = new Fixture();
		const room = newRoom();
		const worker = fixture.spawn(room);
		await worker.ready();
		const guest = await liveGuest(fixture, room);
		guest.sendPrompt("TASK:go");
		await waitUntil("subagent finished", () => agentLines(worker).find(line => line.status === "completed"), 40_000);
		// The task tool runs async: its result reaches the main agent as a follow-up turn.
		await waitUntil("task result reaches the main agent", () => snapshotText(guest.getSnapshot()).includes("sub-done"), 40_000);
		await waitUntil("idle", () => stateLines(worker).at(-1)?.state === "idle");

		const samples = worker.lines.filter((line): line is Extract<typeof line, { t: "usage-sample" }> => line.t === "usage-sample");
		const main = samples.filter(sample => sample.agentId === "Main");
		const children = samples.filter(sample => sample.agentId !== "Main");
		// Main: the turn that called `task`, the one that answered, and the one that took the async result.
		expect(main.length).toBeGreaterThanOrEqual(2);
		expect(children.length).toBeGreaterThanOrEqual(1);
		for (const sample of samples) {
			expect(sample).toMatchObject({ provider: "stub", model: "stub-model", tokens: 15, cacheReadTokens: 0 });
			expect(Math.abs(Date.now() - sample.at)).toBeLessThan(60_000);
		}
	}, 90_000);
});

describe("summarize and refine-title", () => {
	test("key points come from the smol model's JSON; invalid JSON and an empty session are refused", async () => {
		fixture = new Fixture({ configYaml: SMOL_CONFIG });
		const room = newRoom();
		const worker = fixture.spawn(room);
		await worker.ready();
		const empty = errorOf(await worker.request<WorkerRequestResult>({ t: "summarize", id: "empty" }));
		expect(empty).toMatchObject({ code: "conflict" });

		const guest = await liveGuest(fixture, room);
		guest.sendPrompt("Make the retry queue survive a redis restart");
		await waitUntil("echo", () => snapshotText(guest.getSnapshot()).includes("echo:Make the retry queue"));
		const reply = await worker.request<WorkerRequestResult>({ t: "summarize", id: "sum" });
		if (reply.t !== "key-points") throw new Error(`expected key points, got ${JSON.stringify(reply)}`);
		expect(reply.keyPoints).toMatchObject({
			title: "Stub session card",
			goal: "Exercise the stub provider",
			decisions: ["Use the stub model"],
			files: ["src/stub.ts"],
			outcome: "Done",
			openQuestions: [],
		});
		expect(reply.keyPoints.sessionId).toBeString();
		expect(Math.abs(Date.now() - reply.keyPoints.generatedAt)).toBeLessThan(60_000);
	}, 90_000);

	test("a reply that is not the key-points JSON is an error, not a card", async () => {
		fixture = new Fixture({ configYaml: SMOL_CONFIG });
		const room = newRoom();
		const garbage = fixture.spawn(room, [], { STUB_KEYPOINTS: "Sure! Here is the card you asked for." });
		await garbage.ready();
		const guest = await liveGuest(fixture, room);
		guest.sendPrompt("anything worth a card");
		await waitUntil("echo", () => snapshotText(guest.getSnapshot()).includes("echo:anything"));
		const refused = errorOf(await garbage.request<WorkerRequestResult>({ t: "summarize", id: "bad" }));
		expect(refused).toMatchObject({ code: "internal" });
		expect(refused?.message).toContain("JSON");
	}, 90_000);

	test("a card whose fields have the wrong type is refused", async () => {
		fixture = new Fixture({ configYaml: SMOL_CONFIG });
		const room = newRoom();
		const worker = fixture.spawn(room, [], { STUB_KEYPOINTS: JSON.stringify({ title: "ok", decisions: "not an array", files: [], openQuestions: [] }) });
		await worker.ready();
		const guest = await liveGuest(fixture, room);
		guest.sendPrompt("anything worth a card");
		await waitUntil("echo", () => snapshotText(guest.getSnapshot()).includes("echo:anything"));
		const refused = errorOf(await worker.request<WorkerRequestResult>({ t: "summarize", id: "typed" }));
		expect(refused).toMatchObject({ code: "internal" });
		expect(refused?.message).toContain("decisions");
	}, 90_000);

	test("refine-title runs omp's title generator and emits the title; a manual rename emits too and then wins", async () => {
		fixture = new Fixture({ configYaml: SMOL_CONFIG });
		const room = newRoom();
		const worker = fixture.spawn(room);
		await worker.ready();
		const guest = await liveGuest(fixture, room);
		guest.sendPrompt("fix the retry queue dropping jobs after redis restarts");
		await waitUntil("echo", () => snapshotText(guest.getSnapshot()).includes("echo:fix the retry queue"));
		await waitUntil("idle", () => stateLines(worker).at(-1)?.state === "idle");

		const accepted = await worker.request<WorkerRequestResult>({ t: "refine-title", id: "r1" });
		expect(accepted).toEqual({ t: "accepted", id: "r1" });
		const refined = await waitUntil("refined title line", () => titleLines(worker).find(line => line.title === "Refined Stub Title"));
		expect(refined.title).toBe("Refined Stub Title");
		await waitUntil("state carries the title", () => stateLines(worker).at(-1)?.title === "Refined Stub Title");

		const renamed = await worker.request<WorkerRequestResult>({ t: "run-command", id: "rn", text: "/rename My Own Title" });
		expect(renamed).toEqual({ t: "accepted", id: "rn" });
		await waitUntil("manual title line", () => titleLines(worker).find(line => line.title === "My Own Title"));
		expect(titleLines(worker).map(line => line.title)).toEqual(["Refined Stub Title", "My Own Title"]);

		const refused = errorOf(await worker.request<WorkerRequestResult>({ t: "refine-title", id: "r2" }));
		expect(refused).toMatchObject({ code: "conflict" });
		expect(refused?.message).toContain("user");
	}, 90_000);
});

describe("plugins", () => {
	test("lists skills and extension modules; toggling a skill takes it out of the catalog at once and back", async () => {
		fixture = new Fixture();
		plant(fixture, "skills/deck-skill/SKILL.md", "---\nname: deck-skill\ndescription: A skill planted by the plugin tests\n---\nDo the deck thing.\n");
		const worker = fixture.spawn(newRoom());
		await worker.ready();
		const list = async (id: string) => {
			const reply = await worker.request<WorkerRequestResult>({ t: "plugins", id });
			if (reply.t !== "plugins") throw new Error(`expected plugins, got ${JSON.stringify(reply)}`);
			return reply.plugins;
		};

		const plugins = await list("p1");
		const skill = plugins.find(plugin => plugin.id === "skill:deck-skill");
		expect(skill).toMatchObject({ kind: "skill", name: "deck-skill", enabled: true, description: "A skill planted by the plugin tests" });
		expect(plugins.find(plugin => plugin.id === "extension-module:stub-provider")).toMatchObject({ kind: "extension", enabled: true });
		const catalogHas = async (id: string) => {
			const reply = await worker.request<WorkerRequestResult>({ t: "catalog", id });
			if (reply.t !== "catalog") throw new Error("no catalog");
			return reply.catalog.skills.some(entry => entry.name === "deck-skill");
		};
		expect(await catalogHas("c1")).toBe(true);

		expect(await worker.request<WorkerRequestResult>({ t: "plugin-toggle", id: "t1", pluginId: "skill:deck-skill", enabled: false })).toEqual({ t: "accepted", id: "t1" });
		expect((await list("p2")).find(plugin => plugin.id === "skill:deck-skill")?.enabled).toBe(false);
		// The catalog is cached for 10 s; a toggle must not leave it stale.
		expect(await catalogHas("c2")).toBe(false);

		await worker.request<WorkerRequestResult>({ t: "plugin-toggle", id: "t2", pluginId: "skill:deck-skill", enabled: true });
		expect((await list("p3")).find(plugin => plugin.id === "skill:deck-skill")?.enabled).toBe(true);
		expect(await catalogHas("c3")).toBe(true);

		const unknown = errorOf(await worker.request<WorkerRequestResult>({ t: "plugin-toggle", id: "t3", pluginId: "skill:nope", enabled: false }));
		expect(unknown).toMatchObject({ code: "not-found" });
	}, 120_000);

	test("disabling an extension module is stored and the next session of the workspace does not load it", async () => {
		fixture = new Fixture();
		plant(fixture, "extensions/ui-probe.ts", UI_PROBE);
		const first = fixture.spawn(newRoom());
		await first.ready();
		await waitUntil("probe published its status", () => extUiLines(first).at(-1)?.state.statuses[0]?.text === "booted");

		const toggled = await first.request<WorkerRequestResult>({ t: "plugin-toggle", id: "off", pluginId: "extension-module:ui-probe", enabled: false });
		expect(toggled).toEqual({ t: "accepted", id: "off" });
		const listed = await first.request<WorkerRequestResult>({ t: "plugins", id: "after" });
		if (listed.t !== "plugins") throw new Error("no plugins");
		expect(listed.plugins.find(plugin => plugin.id === "extension-module:ui-probe")?.enabled).toBe(false);

		const second = fixture.spawn(newRoom());
		await second.ready();
		await sleep(1500);
		expect(extUiLines(second).filter(line => line.state.statuses.length > 0)).toHaveLength(0);
	}, 120_000);
});

describe("usage", () => {
	test("passes omp's usage reports through with quota fields intact and nothing credential-shaped", async () => {
		fixture = new Fixture();
		const worker = fixture.spawn(newRoom());
		await worker.ready();
		const reply = await worker.request<WorkerRequestResult>({ t: "usage", id: "u1" });
		if (reply.t !== "usage") throw new Error(`expected usage, got ${JSON.stringify(reply)}`);
		const stub = (reply.reports as Array<Record<string, unknown>>).find(report => report.provider === "stub");
		expect(stub).toMatchObject({
			provider: "stub",
			fetchedAt: 1_700_000_000_000,
			limits: [{ id: "5h", window: { id: "5h", resetsAt: 1_700_000_900_000 }, amount: { used: 61, limit: 100, unit: "percent" }, status: "ok" }],
			metadata: { email: "stub@example.com" },
		});
		const json = JSON.stringify(reply);
		expect(json).not.toContain(STUB_FAKE_JWT);
		expect(json).not.toContain("access_token");
		expect(stub).not.toHaveProperty("raw");
	}, 90_000);
});

describe("quota policy", () => {
	const STUB_DENIED = { t: "quota-policy" as const, providers: [{ provider: "stub", admitSpawns: false, holdPrompts: false, reason: "5h window at 96%" }] };
	const STUB_ADMITTED = { t: "quota-policy" as const, providers: [{ provider: "stub", admitSpawns: true, holdPrompts: false }] };

	test("a main-agent spawn waits for admission, past omp's 30 s handler cap, and then runs", async () => {
		fixture = new Fixture();
		const room = newRoom();
		const worker = fixture.spawn(room);
		await worker.ready();
		const guest = await liveGuest(fixture, room);
		worker.send(STUB_DENIED);
		// The task tool runs async: the call returns at once and the held spawn waits inside its background job.
		guest.sendPrompt("TASK:held");
		await waitUntil("task call answered", () => snapshotText(guest.getSnapshot()).includes("Spawned agent"), 20_000);
		await sleep(31_500);
		expect(agentLines(worker)).toHaveLength(0);

		worker.send(STUB_ADMITTED);
		await waitUntil("held spawn started", () => agentLines(worker).find(line => line.status === "started"), 20_000);
		await waitUntil("held spawn completed", () => agentLines(worker).find(line => line.status === "completed"), 30_000);
		await waitUntil("its result reaches the main agent", () => snapshotText(guest.getSnapshot()).includes("sub-done"), 30_000);
	}, 120_000);

	test("aborting a turn that waits on a held synchronous spawn ends the turn, and the spawn never happens", async () => {
		fixture = new Fixture({ configYaml: "async:\n  enabled: false\n" });
		const room = newRoom();
		const worker = fixture.spawn(room);
		await worker.ready();
		const guest = await liveGuest(fixture, room);
		worker.send(STUB_DENIED);
		guest.sendPrompt("TASK:held then aborted");
		await waitUntil("the turn is parked on the spawn", () => stateLines(worker).at(-1)?.state === "streaming");
		await sleep(1500);
		expect(agentLines(worker)).toHaveLength(0);
		expect(stateLines(worker).at(-1)?.state).toBe("streaming");

		const aborted = await worker.request<{ t: "aborted"; id: string; aborted: boolean }>({ t: "abort", id: "ab" });
		expect(aborted.aborted).toBe(true);
		await waitUntil("turn ended", () => stateLines(worker).at(-1)?.state === "idle", 15_000);
		worker.send(STUB_ADMITTED);
		await sleep(2500);
		expect(agentLines(worker)).toHaveLength(0);
	}, 90_000);

	test("children of a running subagent are never held", async () => {
		fixture = new Fixture();
		plantProfile(fixture, "deck-nest", "---\nname: deck-nest\ndescription: Spawns a grandchild for the quota tests\ntools: read, task\nspawns: \"*\"\n---\nYou delegate.\n");
		const room = newRoom();
		const worker = fixture.spawn(room);
		await worker.ready();
		const guest = await liveGuest(fixture, room);
		worker.send(STUB_ADMITTED);
		guest.sendPrompt("NEST:go");
		const nest = await waitUntil("nest agent started", () => agentLines(worker).find(line => line.profile === "deck-nest" && line.status === "started"), 30_000);

		// The child is already running; from now on new top-level spawns are held, but its own children are not.
		worker.send(STUB_DENIED);
		const grandchild = await waitUntil("grandchild started", () => agentLines(worker).find(line => line.status === "started" && line.parentId === nest.agentId), 30_000);
		expect(grandchild.profile).toBe("task");
		await waitUntil("grandchild completed", () => agentLines(worker).find(line => line.agentId === grandchild.agentId && line.status === "completed"), 30_000);
	}, 120_000);

	test("holdPrompts parks a guest prompt behind a visible notice until the policy admits it", async () => {
		fixture = new Fixture();
		const room = newRoom();
		const worker = fixture.spawn(room);
		await worker.ready();
		const guest = await liveGuest(fixture, room);
		worker.send({ t: "quota-policy", providers: [{ provider: "stub", admitSpawns: true, holdPrompts: true, reason: "weekly window at 97%" }] });
		await sleep(300);
		guest.sendPrompt("hello while paused");
		await waitUntil("held notice on the guest", () => guest.getSnapshot().notices.some(notice => notice.message.includes("held by flow control")), 15_000);
		expect(guest.getSnapshot().notices.map(notice => notice.message).join("\n")).toContain("weekly window at 97%");
		await sleep(1000);
		expect(snapshotText(guest.getSnapshot())).not.toContain("echo:hello while paused");

		worker.send(STUB_ADMITTED);
		await waitUntil("the prompt ran after admission", () => snapshotText(guest.getSnapshot()).includes("echo:hello while paused"), 20_000);
	}, 90_000);
});
