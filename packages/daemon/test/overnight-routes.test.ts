import { afterEach, describe, expect, it } from "bun:test";
import type { OvernightState, OvernightTemplate, SessionSummary } from "@omp-console/protocol";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FeatureSettings } from "../src/config";
import { pairDaemon, startTestDaemon, stopTestDaemons, type TestDaemon, type TestDaemonOptions } from "./harness";

afterEach(stopTestDaemons);

function request(task: string, deadline = new Date(Date.now() + 3_600_000).toISOString()) {
	return {
		task,
		policy: {
			deadline,
			askTimeoutSec: 60,
			quiet: "normal",
			maxIdleContinuations: 3,
			keepAwake: false,
		},
	};
}
const OVERNIGHT_FEATURES: FeatureSettings = {
	librarian: false,
	agenda: false,
	quickAsk: false,
	peers: false,
	openrouterDecisions: false,
	computerUse: false,
	overnight: true,
};

function startOvernightDaemon(options: TestDaemonOptions = {}): Promise<TestDaemon> {
	return startTestDaemon({ ...options, features: { ...OVERNIGHT_FEATURES, ...options.features, overnight: true } });
}

async function waitForOvernightPhase(daemon: TestDaemon, sessionId: string, phase: OvernightState["phase"]): Promise<OvernightState> {
	const deadline = Date.now() + 5_000;
	let latest: OvernightState | undefined;
	while (Date.now() < deadline) {
		const response = await daemon.get(`/api/sessions/${sessionId}/overnight`);
		if (response.ok) {
			latest = (await response.json()) as OvernightState;
			if (latest.phase === phase) return latest;
		}
		await Bun.sleep(10);
	}
	throw new Error(`Overnight state did not reach ${phase}: ${JSON.stringify(latest)}`);
}

describe("overnight HTTP API", () => {
	it("stores templates, validates start requests, creates overnight sessions and stops the controller without stopping the session", async () => {
		const daemon = await startOvernightDaemon();
		const original = (await (await daemon.get("/api/overnight/template")).json()) as OvernightTemplate;
		expect(original.policy.deadlineLocalTime).toBe("09:30");
		expect(original.prompt).toContain("The user is asleep and cannot answer until morning.");

		const invalid = await daemon.put("/api/overnight/template", { prompt: "template", policy: { ...original.policy, deadlineLocalTime: "25:00" } });
		expect(invalid.status).toBe(400);
		const saved: OvernightTemplate = {
			prompt: "Use the saved overnight policy.",
			policy: { ...original.policy, deadlineLocalTime: "08:45" },
		};
		expect((await daemon.put("/api/overnight/template", saved)).status).toBe(200);
		expect(await (await daemon.get("/api/overnight/template")).json()).toEqual(saved);

		const invalidStart = await daemon.post("/api/sessions", { cwd: daemon.dir, overnight: { task: " ", policy: {} } });
		expect(invalidStart.status).toBe(400);
		const expiredStart = await daemon.post("/api/sessions", {
			cwd: daemon.dir,
			overnight: request("do not start after the deadline", new Date(Date.now() - 60_000).toISOString()),
		});
		expect(expiredStart.status).toBe(400);

		const createRequest = request("finish the requested work");
		const createdResponse = await daemon.post("/api/sessions", {
			cwd: daemon.dir,
			overnight: createRequest,
		});
		expect(createdResponse.status).toBe(201);
		const created = (await createdResponse.json()) as SessionSummary;
		expect(created.overnight).toMatchObject({ phase: "running", continuations: 0 });
		expect(created.title).toBe("Overnight run: finish the requested work");
		const stateResponse = await daemon.get(`/api/sessions/${created.id}/overnight`);
		const state = (await stateResponse.json()) as OvernightState;
		expect(stateResponse.status).toBe(200);
		expect(state.policy.deadline).toBe(createRequest.policy.deadline);
		expect(state.policy.askTimeoutSec).toBe(60);
		expect(fs.existsSync(`${daemon.stateDir}/overnight/${created.id}.json`)).toBe(true);

		const stopped = await daemon.del(`/api/sessions/${created.id}/overnight`);
		expect(stopped.status).toBe(200);
		expect(((await stopped.json()) as OvernightState).phase).toBe("stopped");
		const stillLive = ((await (await daemon.get("/api/sessions")).json()) as { live: SessionSummary[] }).live.find(row => row.id === created.id);
		expect(stillLive?.state).toBe("idle");
		expect(stillLive?.overnight?.phase).toBe("stopped");
	});

	it("blocks an overnight session when its first prompt cannot be delivered", async () => {
		const daemon = await startOvernightDaemon({ workerFlags: ["--fail-send-prompt"] });
		const response = await daemon.post("/api/sessions", { cwd: daemon.dir, overnight: request("complete the requested work") });
		expect(response.status).toBe(201);
		const created = (await response.json()) as SessionSummary;
		const state = await waitForOvernightPhase(daemon, created.id, "blocked");
		expect(state.events.some(event => event.kind === "blocked" && event.detail.includes("prompt refused"))).toBe(true);
	}, 15_000);

	it("blocks before sending the first prompt when model authentication is unavailable", async () => {
		const logDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "omp-console-overnight-no-auth-"));
		try {
			const requestLog = path.join(logDirectory, "requests.jsonl");
			const daemon = await startOvernightDaemon({
				workerFlags: ["--fail-send-prompt", "--dump-requests", requestLog],
				modelAvailability: async model => ({
					available: false,
					detail: `No authentication source is configured for ${model?.split("/", 1)[0] ?? "the selected model"}; no model call was made.`,
				}),
			});
			const response = await daemon.post("/api/sessions", { cwd: daemon.dir, overnight: request("complete the requested work") });
			expect(response.status).toBe(201);
			const created = (await response.json()) as SessionSummary;
			const state = await waitForOvernightPhase(daemon, created.id, "blocked");
			expect(state.events.some(event => event.kind === "blocked" && event.detail.includes("No authentication source is configured"))).toBe(true);
			const commands = fs.existsSync(requestLog)
				? fs.readFileSync(requestLog, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as { t?: string })
				: [];
			expect(commands.some(command => command.t === "send-prompt")).toBe(false);
		} finally {
			fs.rmSync(logDirectory, { recursive: true, force: true });
		}
	}, 15_000);

	it("the session Stop (abort) ends an overnight run even between turns, and a handoff cannot ride along", async () => {
		const daemon = await startOvernightDaemon();
		const withHandoff = await daemon.post("/api/sessions", { cwd: daemon.dir, handoff: "x", overnight: request("task") });
		expect(withHandoff.status).toBe(400);
		const created = (await (await daemon.post("/api/sessions", { cwd: daemon.dir, overnight: request("task") })).json()) as SessionSummary;
		const abort = await daemon.post(`/api/sessions/${created.id}/abort`, {});
		expect(abort.status).toBe(202);
		const state = (await (await daemon.get(`/api/sessions/${created.id}/overnight`)).json()) as OvernightState;
		expect(state.phase).toBe("stopped");
		// With no overnight run left and nothing streaming, Stop is the usual 409.
		expect((await daemon.post(`/api/sessions/${created.id}/abort`, {})).status).toBe(409);
	});

	it("enables overnight mode on the same idle session and rejects busy and unknown sessions", async () => {
		const idleDaemon = await startOvernightDaemon();
		const regular = (await (await idleDaemon.post("/api/sessions", { cwd: idleDaemon.dir })).json()) as SessionSummary;
		fs.writeFileSync(regular.sessionFile!, "persisted transcript\n");
		const enabled = await idleDaemon.post(`/api/sessions/${regular.id}/overnight`, request("continue this session"));
		expect(enabled.status).toBe(200);
		expect(((await enabled.json()) as OvernightState).sessionId).toBe(regular.id);
		const live = ((await (await idleDaemon.get("/api/sessions")).json()) as { live: SessionSummary[] }).live.find(row => row.id === regular.id);
		expect(live?.overnight?.phase).toBe("running");

		const missing = await idleDaemon.post("/api/sessions/never-created/overnight", request("x"));
		expect(missing.status).toBe(404);

		const busyDaemon = await startOvernightDaemon({ workerFlags: ["--streaming-forever"] });
		const busy = (await (await busyDaemon.post("/api/sessions", { cwd: busyDaemon.dir })).json()) as SessionSummary;
		const conflict = await busyDaemon.post(`/api/sessions/${busy.id}/overnight`, request("do not start"));
		expect(conflict.status).toBe(409);
	});

	it("rejects an overnight request for a resumed or hidden session and validates the preflight cwd", async () => {
		const daemon = await startOvernightDaemon();
		const resumeFile = `${daemon.sessionsDir}/saved.jsonl`;
		fs.writeFileSync(resumeFile, "transcript\n");
		const badResume = await daemon.post("/api/sessions", {
			cwd: daemon.dir,
			resumeSessionFile: resumeFile,
			overnight: request("x"),
		});
		expect(badResume.status).toBe(400);
		const badHidden = await daemon.post("/api/sessions", { cwd: daemon.dir, hidden: true, overnight: request("x") });
		expect(badHidden.status).toBe(400);
		expect((await daemon.get("/api/overnight/preflight?cwd=relative")).status).toBe(400);
	});
	it("keeps every overnight route behind the paired-device gate", async () => {
		const daemon = await startOvernightDaemon({ pair: false });
		const unauthenticated = await Promise.all([
			daemon.unauthenticated("/api/overnight/template"),
			daemon.unauthenticated("/api/overnight/template", "PUT", {}),
			daemon.unauthenticated("/api/overnight/preflight?cwd=%2Ftmp"),
			daemon.unauthenticated("/api/sessions", "POST", { cwd: daemon.dir, overnight: request("task") }),
			daemon.unauthenticated("/api/sessions/session-id/overnight"),
			daemon.unauthenticated("/api/sessions/session-id/overnight", "POST", request("task")),
			daemon.unauthenticated("/api/sessions/session-id/overnight", "DELETE"),
		]);
		expect(unauthenticated.map(response => response.status)).toEqual([401, 401, 401, 401, 401, 401, 401]);

		const cookie = await pairDaemon(daemon.url, daemon.stateDir);
		const paired = await fetch(`${daemon.url}/api/overnight/template`, { headers: { Cookie: cookie } });
		expect(paired.status).toBe(200);
	});
});
