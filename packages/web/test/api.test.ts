import { describe, expect, it } from "bun:test";
import type { AbortSessionResponse, ArchiveSessionRecord, DaemonHealth, ListSessionsResponse, RoomLinkResponse, SessionSummary } from "@omp-console/protocol";
import { DeckApi, DeckApiError, type FetchLike } from "../src/lib/api";

interface Call {
	url: string;
	method: string;
	body: unknown;
}

/** Fake daemon: records calls, answers with the queued response. */
function fakeFetch(responses: (Response | Error)[]): { fetch: FetchLike; calls: Call[] } {
	const calls: Call[] = [];
	const fetch: FetchLike = async (input, init) => {
		calls.push({
			url: input,
			method: init?.method ?? "GET",
			body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
		});
		const next = responses.shift();
		if (!next) throw new Error("unexpected request");
		if (next instanceof Error) throw next;
		return next;
	};
	return { fetch, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const SUMMARY: SessionSummary = {
	id: "s/1",
	cwd: "/work",
	state: "idle",
	createdAt: 1,
	lastActivityAt: 2,
	agentCount: 0,
	goalActive: false,
	awaitingAnswer: false,
};

async function failureOf(promise: Promise<unknown>): Promise<DeckApiError> {
	try {
		await promise;
	} catch (err) {
		if (err instanceof DeckApiError) return err;
		throw err;
	}
	throw new Error("expected the call to fail");
}

describe("DeckApi calls", () => {
	it("sends typed requests to relative /api URLs and returns the parsed bodies", async () => {
		const list: ListSessionsResponse = { live: [SUMMARY], recent: [] };
		const room: RoomLinkResponse = { roomId: "room", link: "ws://x/r/room#k", permission: "full" };
		const health: DaemonHealth = { version: 1, startedAt: 1, workers: [], guests: 0, stalledAfterMs: 60_000 };
		const archive: ArchiveSessionRecord = {
			archivedAt: 3,
			title: "title",
			cwd: "/work",
			sessionFile: "/work/a.jsonl",
			lastActivityAt: 2,
		};
		const { fetch, calls } = fakeFetch([
			jsonResponse(list),
			jsonResponse(SUMMARY),
			jsonResponse(room),
			jsonResponse({}),
			jsonResponse(health),
			jsonResponse({ aborted: true } satisfies AbortSessionResponse, 202),
			jsonResponse(archive),
			new Response(null, { status: 204 }),
		]);
		const api = new DeckApi({ fetch });

		expect(await api.listSessions()).toEqual(list);
		expect(await api.createSession({ cwd: "/work", resumeSessionFile: "/work/a.jsonl" })).toEqual(SUMMARY);
		expect(await api.roomLink("s/1")).toEqual(room);
		await api.stopSession("s/1");
		expect(await api.health()).toEqual(health);
		expect(await api.abortSession("s/1")).toEqual({ aborted: true });
		expect(await api.archiveSession("s/1", { stopIfLive: true })).toEqual(archive);
		await api.restoreSession("s/1");

		expect(calls).toEqual([
			{ url: "/api/sessions", method: "GET", body: undefined },
			{ url: "/api/sessions", method: "POST", body: { cwd: "/work", resumeSessionFile: "/work/a.jsonl" } },
			{ url: "/api/sessions/s%2F1/room", method: "POST", body: undefined },
			{ url: "/api/sessions/s%2F1", method: "DELETE", body: undefined },
			{ url: "/api/health", method: "GET", body: undefined },
			{ url: "/api/sessions/s%2F1/abort", method: "POST", body: undefined },
			{ url: "/api/sessions/s%2F1/archive", method: "PUT", body: { stopIfLive: true } },
			{ url: "/api/sessions/s%2F1/archive", method: "DELETE", body: undefined },
		]);
	});
	it("starts a saved recipe with a request idempotency key on the selected daemon", async () => {
		const { fetch, calls } = fakeFetch([jsonResponse(SUMMARY)]);
		const api = new DeckApi({ base: "/api/peers/vps", fetch });

		expect(await api.startRecipe("nightly/1", "request-1")).toEqual(SUMMARY);
		expect(calls).toEqual([
			{
				url: "/api/peers/vps/recipes/nightly%2F1/start",
				method: "POST",
				body: { idempotencyKey: "request-1" },
			},
		]);
		expect(api.isLocalMachine).toBe(false);
		expect(new DeckApi({ base: "/api" }).isLocalMachine).toBe(true);
	});
	it("posts a sleep request to the encoded session endpoint", async () => {
		const { fetch, calls } = fakeFetch([jsonResponse({ state: "asleep" })]);
		const api = new DeckApi({ fetch });

		expect(await api.sleepSession("s/1")).toEqual({ state: "asleep" });
		expect(calls).toEqual([{ url: "/api/sessions/s%2F1/sleep", method: "POST", body: undefined }]);
	});
	it("uploads raw bytes through the session API and reports transfer progress", async () => {
		const progress: number[] = [];
		const bytes = new Uint8Array([0, 255, 10]);
		const file = new File([bytes], "notes & plans.txt", { type: "text/plain" });
		const controller = new AbortController();
		let request: { url: string; bytes: number[]; signal?: AbortSignal } | undefined;
		const api = new DeckApi({
			base: "/api/peers/vps",
			upload: async (url, body, options) => {
				request = { url, bytes: [...new Uint8Array(await body.arrayBuffer())], signal: options.signal };
				options.onProgress?.(2, 3);
				return jsonResponse({ path: "/remote/uploads/notes.txt", name: "notes.txt", size: 3 });
			},
		});

		const uploaded = await api.uploadFile("session/1", file, {
			signal: controller.signal,
			onProgress: (loaded, total) => progress.push(loaded, total),
		});

		expect(request).toEqual({
			url: "/api/peers/vps/sessions/session%2F1/uploads?name=notes+%26+plans.txt",
			bytes: [0, 255, 10],
			signal: controller.signal,
		});
		expect(progress).toEqual([2, 3]);
		expect(uploaded).toEqual({ path: "/remote/uploads/notes.txt", name: "notes.txt", size: 3 });
	});

});

describe("DeckApi error mapping", () => {
	const cases: { name: string; response: Response; kind: DeckApiError["kind"]; message?: string }[] = [
		{
			name: "401 with an ApiError body is an auth failure carrying the daemon's message",
			response: jsonResponse({ error: "owner identity required", code: "unauthorized" }, 401),
			kind: "auth",
			message: "owner identity required",
		},
		{
			name: "a bare 403 (proxy) is an auth failure",
			response: new Response("forbidden", { status: 403 }),
			kind: "auth",
		},
		{
			name: "409 means the worker is not ready",
			response: jsonResponse({ error: "worker starting", code: "conflict" }, 409),
			kind: "conflict",
		},
		{
			name: "404 with an ApiError body",
			response: jsonResponse({ error: "no such live session", code: "not-found" }, 404),
			kind: "not-found",
		},
		{
			name: "400",
			response: jsonResponse({ error: "cwd is required", code: "bad-request" }, 400),
			kind: "bad-request",
		},
		{
			name: "500 with an HTML error page",
			response: new Response("<html>oops</html>", { status: 500 }),
			kind: "server",
		},
	];
	for (const { name, response, kind, message } of cases) {
		it(name, async () => {
			const api = new DeckApi({ fetch: fakeFetch([response]).fetch });
			const err = await failureOf(api.listSessions());
			expect(err.kind).toBe(kind);
			expect(err.status).toBe(response.status);
			if (message) expect(err.message).toBe(message);
		});
	}
	it("preserves the sleep candidate supplied with a worker-limit conflict", async () => {
		const candidate = { id: "sleep/oldest", title: "Oldest session", idleMinutes: 42 };
		const api = new DeckApi({
			fetch: fakeFetch([
				jsonResponse({ error: "worker limit reached", code: "conflict", sleepCandidate: candidate }, 409),
			]).fetch,
		});

		const error = await failureOf(api.createSession({ cwd: "/work/new" }));
		expect(error).toMatchObject({ kind: "conflict", status: 409, sleepCandidate: candidate });
	});

	it("a refused connection is a network failure with status 0", async () => {
		const api = new DeckApi({ fetch: fakeFetch([new TypeError("fetch failed")]).fetch });
		const err = await failureOf(api.health());
		expect(err.kind).toBe("network");
		expect(err.status).toBe(0);
	});

	it("a 200 that is not JSON (captive portal, wrong origin) is a server failure, not an empty list", async () => {
		const api = new DeckApi({ fetch: fakeFetch([new Response("<html>sign in</html>", { status: 200 })]).fetch });
		expect((await failureOf(api.listSessions())).kind).toBe("server");
	});

	it("an aborted request rethrows the abort instead of reporting the daemon as unreachable", async () => {
		const controller = new AbortController();
		const abort = new DOMException("aborted", "AbortError");
		const fetch: FetchLike = async () => {
			controller.abort();
			throw abort;
		};
		await expect(new DeckApi({ fetch }).listSessions(controller.signal)).rejects.toBe(abort);
	});
});
