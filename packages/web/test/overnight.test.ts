import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { OvernightTemplate, PreflightCheck } from "@omp-console/protocol";
import { type MockDaemon, startMockDaemon } from "../dev/mock-daemon";
import { DeckApi } from "../src/lib/api";
import {
	buildOvernightRequest,
	canStartOvernight,
	DEFAULT_OVERNIGHT_TEMPLATE,
	nextLocalDeadline,
	overnightPhaseLabel,
	validateOvernightTemplate,
} from "../src/lib/overnight";

const OK_CHECK: PreflightCheck = { id: "workspace", label: "Workspace", status: "ok", detail: "Ready." };
const WARN_CHECK: PreflightCheck = { id: "access", label: "Access", status: "warn", detail: "Review access.", fix: "Check permissions." };
const FAIL_CHECK: PreflightCheck = { id: "permission", label: "Permission", status: "fail", detail: "A required permission is missing.", fix: "Grant the permission." };

describe("overnight request policy", () => {
	it("trims the task, applies saved policy defaults, and builds an offset deadline", () => {
		const template: OvernightTemplate = {
			...DEFAULT_OVERNIGHT_TEMPLATE,
			policy: { ...DEFAULT_OVERNIGHT_TEMPLATE.policy, askTimeoutSec: 90, quiet: "silent", maxIdleContinuations: 2, keepAwake: false },
		};
		const request = buildOvernightRequest("  run the checks  ", template, {}, new Date("2026-10-27T04:50:00.000Z"), "America/Chicago");
		expect(request.task).toBe("run the checks");
		expect(request.prompt).toBe(template.prompt);
		expect(request.policy).toEqual({
			deadline: "2026-10-27T09:30:00-05:00",
			askTimeoutSec: 90,
			quiet: "silent",
			maxIdleContinuations: 2,
			keepAwake: false,
		});
	});

	it("computes the next local date across midnight and the spring DST change", () => {
		expect(nextLocalDeadline("09:30", new Date("2026-10-27T04:50:00.000Z"), "America/Chicago"))
			.toBe("2026-10-27T09:30:00-05:00");
		expect(nextLocalDeadline("09:30", new Date("2026-03-08T06:30:00.000Z"), "America/New_York"))
			.toBe("2026-03-08T09:30:00-04:00");
	});

	it("moves a nonexistent spring wall time forward and chooses the second fall-back occurrence when needed", () => {
		expect(nextLocalDeadline("02:30", new Date("2026-03-08T06:00:00.000Z"), "America/New_York"))
			.toBe("2026-03-08T03:30:00-04:00");
		expect(nextLocalDeadline("01:30", new Date("2026-11-01T05:45:00.000Z"), "America/New_York"))
			.toBe("2026-11-01T01:30:00-05:00");
	});

	it("lets warnings pass preflight, blocks failures, and rejects invalid saved settings", () => {
		expect(canStartOvernight([OK_CHECK, WARN_CHECK])).toBe(true);
		expect(canStartOvernight([OK_CHECK, FAIL_CHECK])).toBe(false);
		expect(validateOvernightTemplate(DEFAULT_OVERNIGHT_TEMPLATE)).toEqual([]);
		expect(validateOvernightTemplate({
			...DEFAULT_OVERNIGHT_TEMPLATE,
			policy: { ...DEFAULT_OVERNIGHT_TEMPLATE.policy, askTimeoutSec: 0, deadlineLocalTime: "25:00" },
		})).toHaveLength(2);
		// The daemon rejects these too; the form must not offer a save that would fail.
		for (const policy of [{ askTimeoutSec: 86_401 }, { maxIdleContinuations: 0 }, { maxIdleContinuations: 101 }]) {
			expect(validateOvernightTemplate({ ...DEFAULT_OVERNIGHT_TEMPLATE, policy: { ...DEFAULT_OVERNIGHT_TEMPLATE.policy, ...policy } })).toHaveLength(1);
		}
	});

	it("labels retry and usage waits from their scheduled action time", () => {
		expect(overnightPhaseLabel("waiting-retry", { nextActionAt: 301_000 }, 1_000)).toBe("Retrying in 5 min");
		const usageResetAt = Date.parse("2026-10-27T08:10:00-05:00");
		const usageResetLabel = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(usageResetAt));
		expect(overnightPhaseLabel("waiting-usage", { nextActionAt: usageResetAt }, usageResetAt - 10 * 60_000))
			.toBe(`Waiting for usage reset until ${usageResetLabel}`);
		expect(overnightPhaseLabel("complete")).toBe("Complete");
	});
});

describe("overnight mock daemon routes", () => {
	let daemon: MockDaemon;
	let api: DeckApi;

	beforeAll(async () => {
		daemon = await startMockDaemon({ port: 0, seed: false, features: ["overnight"] });
		api = new DeckApi({ base: `${daemon.url}/api` });
	});

	afterAll(async () => {
		await daemon.stop();
	});

	it("stores a validated template and exposes selectable preflight scenarios", async () => {
		const original = await api.getOvernightTemplate();
		const edited: OvernightTemplate = {
			...original,
			prompt: "Use the saved night policy.",
			policy: { ...original.policy, deadlineLocalTime: "08:45", quiet: "silent" },
		};
		try {
			expect(await api.setOvernightTemplate(edited)).toEqual(edited);
			expect(await api.getOvernightTemplate()).toEqual(edited);
			await expect(api.setOvernightTemplate({
				...edited,
				policy: { ...edited.policy, deadlineLocalTime: "25:00" },
			})).rejects.toMatchObject({ kind: "bad-request" });
			const mixed = await api.getOvernightPreflight("/tmp/deck-workspace");
			expect(mixed.checks.map(check => check.status)).toEqual(["ok", "warn", "ok"]);
			const failed = await fetch(`${daemon.url}/api/overnight/preflight?cwd=%2Ftmp%2Fdeck-workspace&scenario=fail`);
			const failedBody = await failed.json() as { checks: PreflightCheck[] };
			expect(failedBody.checks.some(check => check.status === "fail" && check.fix !== undefined)).toBe(true);
		} finally {
			await api.setOvernightTemplate(original);
		}
	});

	it("creates and advances an overnight session through its report and summary", async () => {
		const request = buildOvernightRequest("exercise the mock overnight controller", DEFAULT_OVERNIGHT_TEMPLATE);
		const session = await api.createSession({ cwd: "/tmp/deck-overnight-create", overnight: request });
		expect(session.overnight?.phase).toBe("running");
		expect(session.overnight?.deadline).toBe(request.policy?.deadline);
		let state = await api.getOvernightState(session.id);
		const stopAt = Date.now() + 8_000;
		while (state.phase !== "complete" && Date.now() < stopAt) {
			await Bun.sleep(120);
			state = await api.getOvernightState(session.id);
		}
		expect(state.phase).toBe("complete");
		expect(state.events.map(event => event.kind)).toEqual(expect.arrayContaining(["continue", "retry-wait", "complete"]));
		expect(state.report).toContain("## Verified");
		const sessions = await api.listSessions();
		expect(sessions.live.find(item => item.id === session.id)?.overnight).toMatchObject({
			phase: "complete",
			deadline: request.policy?.deadline,
			continuations: 1,
		});
	});

	it("starts overnight on an idle session, stops only the controller, and rejects a busy session", async () => {
		const request = buildOvernightRequest("continue this session tonight", DEFAULT_OVERNIGHT_TEMPLATE);
		const session = await api.createSession({ cwd: "/tmp/deck-overnight-existing" });
		expect((await api.startOvernight(session.id, request)).phase).toBe("running");
		const stopped = await api.stopOvernight(session.id);
		expect(stopped.phase).toBe("stopped");
		expect(stopped.report).toContain("session remains available");
		expect((await api.listSessions()).live.some(item => item.id === session.id)).toBe(true);

		const busyDaemon = await startMockDaemon({ port: 0, seed: true, features: ["overnight"] });
		try {
			const busyApi = new DeckApi({ base: `${busyDaemon.url}/api` });
			const busySessionId = busyDaemon.liveIds()[1]!;
			await expect(busyApi.startOvernight(busySessionId, request)).rejects.toMatchObject({ kind: "conflict" });
		} finally {
			await busyDaemon.stop();
		}
	});
});
