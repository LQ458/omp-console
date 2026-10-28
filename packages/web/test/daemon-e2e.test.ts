import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { startMockDaemon, type MockDaemon } from "../dev/mock-daemon";
import { stopTurn } from "../src/lib/away";
import { DeckApi, DeckApiError } from "../src/lib/api";
import { GuestClient } from "../src/lib/client";
import { SessionSwitcher } from "../src/lib/switcher";

/** Polls until `check` holds; the sockets here are real, so progress is asynchronous. */
async function until(check: () => boolean, what: string, timeoutMs = 4_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(10);
	}
}

describe("web client against the mock daemon", () => {
	let daemon: MockDaemon;
	let api: DeckApi;

	beforeAll(async () => {
		daemon = await startMockDaemon({ port: 0 });
		api = new DeckApi({ base: `${daemon.url}/api` });
	});
	afterAll(async () => {
		await daemon.stop();
	});

	it("defaults overnight off and omits its routes until enabled", async () => {
		expect(await api.capabilities()).toEqual({
			features: {
				librarian: false,
				agenda: false,
				quickAsk: false,
				peers: false,
				openrouterDecisions: false,
				computerUse: false,
				overnight: false,
			},
			quickAskSources: [],
		});
		const disabledRequests: Array<{ path: string; init?: RequestInit }> = [
			{ path: "/cards" },
			{ path: "/brief" },
			{ path: "/agenda/today" },
			{ path: "/agenda/todos" },
			{ path: "/agenda/ask", init: { method: "POST" } },
			{ path: "/quick-ask", init: { method: "POST", body: JSON.stringify({ question: "hello" }) } },
			{ path: "/peers" },
			{ path: "/overnight/template" },
			{ path: "/overnight/preflight?cwd=%2Ftmp" },
		];
		for (const request of disabledRequests) {
			expect((await fetch(`${daemon.url}/api${request.path}`, request.init)).status).toBe(404);
		}
		const deniedOvernightStart = await fetch(`${daemon.url}/api/sessions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: "/tmp", overnight: { task: "make a small change" } }),
		});
		expect(deniedOvernightStart.status).toBe(400);

		const enabled = await startMockDaemon({ port: 0, seed: false, features: "all" });
		try {
			const enabledApi = new DeckApi({ base: `${enabled.url}/api` });
			expect(await enabledApi.capabilities()).toEqual({
				features: {
					librarian: true,
					agenda: true,
					quickAsk: true,
					peers: true,
					openrouterDecisions: true,
					computerUse: true,
					overnight: true,
				},
				quickAskSources: ["siyuan", "repo", "web", "history"],
			});
			for (const route of ["/cards", "/brief", "/agenda/today", "/peers", "/overnight/template", "/overnight/preflight?cwd=%2Ftmp"]) {
				expect((await fetch(`${enabled.url}/api${route}`)).status).toBe(200);
			}
			expect((await fetch(`${enabled.url}/api/quick-ask`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ question: "What is the project deadline?", sources: ["siyuan"] }),
			})).status).toBe(202);
			expect((await fetch(`${enabled.url}/api/quick-ask`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ question: "What is the project deadline?", sources: ["unconfigured"] }),
			})).status).toBe(400);
		} finally {
			await enabled.stop();
		}
	});
	it("joins a live session through the daemon's room link, switches, creates, and stops", async () => {
		const switcher = new SessionSwitcher<GuestClient>({
			api,
			name: "e2e",
			createClient: (link, name) => new GuestClient(link, name),
		});
		await switcher.refresh();
		const live = switcher.getSnapshot().sessions?.live ?? [];
		expect(live).toHaveLength(2);

		await switcher.select(live[0]!.id);
		const first = switcher.getSnapshot().client!;
		await until(() => first.getSnapshot().phase === "live", "first session to go live");
		expect(first.getSnapshot().entries.length).toBeGreaterThan(0);

		await switcher.select(live[1]!.id);
		const second = switcher.getSnapshot().client!;
		expect(second).not.toBe(first);
		expect(first.getSnapshot().phase).toBe("ended"); // closed by the switch
		await until(() => second.getSnapshot().phase === "live", "second session to go live");
		expect(second.getSnapshot().header?.id).toBe(live[1]!.id);

		await switcher.create({ cwd: "/Users/alice/fresh" });
		const created = switcher.getSnapshot().client!;
		await until(() => created.getSnapshot().phase === "live", "new session to go live");
		expect(daemon.liveIds()).toHaveLength(3);

		await switcher.stop(switcher.getSnapshot().selectedId!);
		expect(switcher.getSnapshot().client).toBeNull();
		await switcher.refresh();
		expect(switcher.getSnapshot().sessions?.live).toHaveLength(2);
		expect(switcher.getSnapshot().sessions?.recent.some(s => s.cwd === "/Users/alice/fresh")).toBe(true);
		switcher.dispose();
	});
	it("aborts a background turn through the daemon and drops its queued prompts", async () => {
		const sessionId = (await api.listSessions()).live[0]!.id;
		const switcher = new SessionSwitcher<GuestClient>({
			api,
			name: "abort-e2e",
			createClient: (link, name) => new GuestClient(link, name),
		});
		try {
			await switcher.select(sessionId);
			const connected = switcher.getSnapshot().client!;
			await until(() => connected.getSnapshot().phase === "live", "session to go live for abort");
			connected.sendPrompt("start a turn");
			await until(() => connected.getSnapshot().working, "turn to start");
			connected.sendPrompt("queue another turn");
			await until(() => connected.getSnapshot().state?.queuedMessageCount === 1, "prompt to queue");

			switcher.leave();
			expect(await stopTurn(api, sessionId)).toBe("aborted");
			expect((await api.listSessions()).live.find(session => session.id === sessionId)?.state).toBe("idle");

			await switcher.select(sessionId);
			const rejoined = switcher.getSnapshot().client!;
			await until(() => rejoined.getSnapshot().phase === "live", "session to rejoin after abort");
			expect(rejoined.getSnapshot().state?.queuedMessageCount).toBe(0);
			await Bun.sleep(150);
			expect(rejoined.getSnapshot().working).toBe(false);
			expect(await stopTurn(api, sessionId)).toBe("idle");
			expect(await stopTurn(api, "missing")).toBe("unavailable");
		} finally {
			switcher.dispose();
		}
	});


	it("pairs devices against an unpaired daemon and revokes them independently", async () => {
		const unpaired = await startMockDaemon({ port: 0, paired: false, seed: false });
		const pairingApi = new DeckApi({ base: `${unpaired.url}/api` });
		try {
			expect(await pairingApi.pairStatus()).toEqual({ paired: false });
			let wrongCodeError: unknown;
			try {
				await pairingApi.pair("ABCD-0000", "Browser");
			} catch (error) {
				wrongCodeError = error;
			}
			expect(wrongCodeError).toBeInstanceOf(DeckApiError);
			expect((wrongCodeError as DeckApiError).status).toBe(400);
			const first = await pairingApi.pair("ABCD-2345", "Browser");
			expect(await pairingApi.pairStatus()).toEqual({ paired: true });
			expect((await pairingApi.devices()).devices).toContainEqual(expect.objectContaining({ id: first.deviceId, label: "Browser" }));

			const issued = await pairingApi.issuePairingCode();
			expect(issued.code).toBe("WXYZ-6789");
			const second = await pairingApi.pair(issued.code, "Phone");
			let reusedCodeError: unknown;
			try {
				await pairingApi.pair(issued.code, "Duplicate phone");
			} catch (error) {
				reusedCodeError = error;
			}
			expect(reusedCodeError).toBeInstanceOf(DeckApiError);
			expect((reusedCodeError as DeckApiError).status).toBe(410);
			expect((await pairingApi.devices()).devices).toHaveLength(2);

			expect(await pairingApi.revokeDevice(second.deviceId)).toEqual({ revoked: second.deviceId, loggedOut: false });
			expect((await pairingApi.devices()).devices).toHaveLength(1);
			expect(await pairingApi.revokeDevice(first.deviceId)).toEqual({ revoked: first.deviceId, loggedOut: true });
			expect(await pairingApi.pairStatus()).toEqual({ paired: false });
		} finally {
			await unpaired.stop();
		}
	});

	it("maps an unknown session to not-found", async () => {
		try {
			await api.roomLink("nope");
			throw new Error("expected failure");
		} catch (err) {
			expect(err).toBeInstanceOf(DeckApiError);
			expect((err as DeckApiError).kind).toBe("not-found");
		}
	});

	it("an unauthorized daemon surfaces the auth state to the switcher", async () => {
		const denied = await startMockDaemon({ port: 0, deny: true, seed: false });
		try {
			const switcher = new SessionSwitcher<GuestClient>({
				api: new DeckApi({ base: `${denied.url}/api` }),
				name: "e2e",
				createClient: (link, name) => new GuestClient(link, name),
			});
			await switcher.refresh();
			expect(switcher.getSnapshot()).toMatchObject({ authFailed: true, sessions: null });
			switcher.dispose();
		} finally {
			await denied.stop();
		}
	});
});
