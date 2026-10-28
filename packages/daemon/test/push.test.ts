import { afterEach, describe, expect, it } from "bun:test";
import type { PendingUiRequest, PushPayload, PushPublicKeyResponse, SessionSummary } from "@omp-console/protocol";
import * as fs from "node:fs";
import * as path from "node:path";
import { PushStore } from "../src/push";
import { type PushFetch, PushSender, type SessionDescription, updateLine } from "../src/push-sender";
import { readLatestAgentReply } from "../src/librarian/transcript";
import { PushAnswerTokenStore } from "../src/push-answer";
import type { CrashEvent, NotifyEvent } from "../src/supervisor";
import { FakePushService, type Subscriber } from "./fake-push-service";
import { type TestDaemon, startTestDaemon, stopTestDaemons } from "./harness";
import { makeTmp } from "./helpers";
import { until } from "./ws-helpers";

const services: FakePushService[] = [];
const senders: PushSender[] = [];

afterEach(async () => {
	for (const service of services.splice(0)) service.stop();
	await Promise.all(senders.splice(0).map(sender => sender.close()));
	await stopTestDaemons();
});

/** A sender over a fresh state dir with a fake clock; the service verifies against whatever key this sender made. */
async function senderFixture(
	options: {
		ttlSeconds?: number;
		timeoutMs?: number;
		turnFinishedThresholdMs?: number;
		wrapFetch?: (inner: PushFetch) => PushFetch;
		listUiRequests?: (sessionId: string) => Promise<PendingUiRequest[]>;
		describe?: (sessionId: string) => Promise<SessionDescription>;
	} = {},
) {
	const { wrapFetch, ...senderOptions } = options;
	const stateDir = makeTmp("deck-push-state-");
	const store = new PushStore(stateDir);
	const logs: string[] = [];
	const clock = { now: 1_000_000 };
	const answerTokens = new PushAnswerTokenStore(() => clock.now);
	let key = "";
	const service = new FakePushService(() => key);
	services.push(service);
	const sender = await PushSender.open({
		stateDir,
		store,
		fetch: wrapFetch ? wrapFetch(service.fetch) : service.fetch,
		now: () => clock.now,
		log: message => logs.push(message),
		answerTokens,
		...senderOptions,
	});
	senders.push(sender);
	key = sender.publicKey;
	async function subscribe(pathname: string, behavior?: Parameters<FakePushService["subscribe"]>[1]): Promise<Subscriber> {
		const subscriber = service.subscribe(pathname, behavior);
		await store.add({ endpoint: subscriber.endpoint, keys: subscriber.keys });
		return subscriber;
	}
	return { stateDir, store, logs, clock, service, sender, answerTokens, subscribe };
}

function notifyEvent(sessionId: string, reason: NotifyEvent["reason"], extra: Partial<NotifyEvent> = {}): NotifyEvent {
	return { sessionId, reason, ...(reason === "turn-finished" ? { durationMs: 300_001 } : {}), ...extra };
}

function crashEvent(sessionId: string, title?: string): CrashEvent {
	const event: CrashEvent = { sessionId, exitCode: 1, signal: null, restarts: 0, willRestart: true };
	if (title !== undefined) event.title = title;
	return event;
}

describe("push delivery", () => {
	it("sends an encrypted, VAPID-signed, high-urgency push whose text is the session title plus a fixed phrase", async () => {
		const f = await senderFixture();
		await f.subscribe("/phone");
		await f.sender.notify(
			notifyEvent("sess-1", "needs-answer", { title: "Fix the build", summary: "SECRET tool output: cat /Users/alice/.ssh/test-key" }),
		);
		expect(f.service.rejections).toEqual([]);
		const [push] = f.service.pushesTo("/phone");
		expect(push!.payload).toEqual({
			reason: "needs-answer",
			sessionId: "sess-1",
			title: "Fix the build",
			body: "Needs your answer",
			tag: "sess-1:needs-answer",
			url: "/#session=sess-1",
		} satisfies PushPayload);
		expect(push!.text).not.toContain("SECRET");
		expect(push!.headers.urgency).toBe("high");
		expect(push!.headers.ttl).toBe("3600");
		expect(push!.headers["content-encoding"]).toBe("aes128gcm");
		expect(push!.claims.aud).toBe("https://push.test.invalid");
	});

	it("sends completion pushes only above five minutes without delaying questions or approvals", async () => {
		const f = await senderFixture();
		await f.subscribe("/phone");

		await f.sender.notify(notifyEvent("same", "turn-finished", { durationMs: 300_000 }));
		await f.sender.notify(notifyEvent("same", "turn-finished", { durationMs: 300_001 }));
		await f.sender.notify(notifyEvent("question", "needs-answer", { durationMs: 1 }));
		await f.sender.notify(notifyEvent("approval", "needs-approval", { durationMs: 1 }));

		expect(f.service.pushesTo("/phone").map(push => [push.payload.sessionId, push.payload.reason])).toEqual([
			["same", "turn-finished"],
			["question", "needs-answer"],
			["approval", "needs-approval"],
		]);
	});

	it("honours a caller-supplied turn completion threshold", async () => {
		const f = await senderFixture({ turnFinishedThresholdMs: 60_000 });
		await f.subscribe("/phone");

		await f.sender.notify(notifyEvent("same", "turn-finished", { durationMs: 60_000 }));
		await f.sender.notify(notifyEvent("same", "turn-finished", { durationMs: 60_001 }));

		expect(f.service.pushesTo("/phone").map(push => push.payload.sessionId)).toEqual(["same"]);
	});
	it("uses a fixed phrase per reason and a configurable TTL", async () => {
		const f = await senderFixture({ ttlSeconds: 120 });
		await f.subscribe("/phone");
		const reasons: Array<[NotifyEvent["reason"], string]> = [
			["turn-finished", "Turn finished"],
			["needs-answer", "Needs your answer"],
			["needs-approval", "Needs your approval"],
		];
		for (const [reason] of reasons) await f.sender.notify(notifyEvent("s", reason, { title: "T" }));
		await f.sender.crashed(crashEvent("s", "T"));
		const pushes = f.service.pushesTo("/phone");
		expect(pushes.map(p => [p.payload.reason, p.payload.body])).toEqual([...reasons, ["worker-crashed", "Session crashed"]]);
		expect(new Set(pushes.map(p => p.headers.ttl))).toEqual(new Set(["120"]));
	});

	it("flattens control characters and truncates the title; a missing title falls back to a fixed one", async () => {
		const f = await senderFixture();
		await f.subscribe("/phone");
		await f.sender.notify(notifyEvent("a", "needs-answer", { title: "line one\nline\ttwo\u0007" }));
		await f.sender.notify(notifyEvent("b", "needs-answer", { title: "x".repeat(500) }));
		await f.sender.notify(notifyEvent("c", "needs-answer", { title: " \n " }));
		await f.sender.notify(notifyEvent("d", "needs-answer"));
		await f.sender.notify(notifyEvent("e", "turn-finished", { title: "x".repeat(500) }));
		const titles = f.service.pushesTo("/phone").map(p => p.payload.title);
		expect(titles[0]).toBe("line one line two");
		expect(titles[1]).toBe(`${"x".repeat(79)}…`);
		expect(titles.slice(2, 4)).toEqual(["omp console session", "omp console session"]);
		expect(titles[4]).toBe(`${"x".repeat(70)}… finished`);
	});

	it("names a finished task as the session list does and says what the agent last reported", async () => {
		const f = await senderFixture({
			describe: async sessionId =>
				sessionId === "broken"
					? Promise.reject(new Error("no card"))
					: {
							title: "Documentation review",
							latestReply: "## Done\n\n**Updated the source guide.** Next I will verify the examples.\n- a list",
						},
		});
		await f.subscribe("/phone");
		await f.sender.notify(notifyEvent("ok", "turn-finished", { title: "omp title" }));
		await f.sender.notify(notifyEvent("ok", "needs-answer", { title: "omp title" }));
		await f.sender.notify(notifyEvent("broken", "turn-finished", { title: "omp title" }));
		expect(f.service.pushesTo("/phone").map(p => [p.payload.title, p.payload.body])).toEqual([
			["Documentation review finished", "Updated the source guide."],
			["Documentation review", "Needs your answer"],
			["omp title finished", "Turn finished"],
		]);
	});

	it("takes the first prose sentence of the reply: no code, math, tables or HTML, capped at 120 characters", () => {
		expect(updateLine("**Updated the source guide.** Next I will verify the examples.")).toBe("Updated the source guide.");
		expect(updateLine("\n\n> Updated the source guide. Next I will verify the examples.")).toBe("Updated the source guide.");
		expect(updateLine("See [the brief](https://x.test/a) for `details`")).toBe("See the brief for details");
		expect(updateLine("```ts\nconst apiKey = process.env.KEY;\n```\nDone: wrote the helper.")).toBe("Done: wrote the helper.");
		expect(updateLine("```\nnpm test\n```\nAll green.")).toBe("All green.");
		expect(updateLine("$$\nx^2\n$$\n$$y$$\nSolved it.")).toBe("Solved it.");
		expect(updateLine("| file | status |\n|---|---|\n| a | ok |\nAll files pass.")).toBe("All files pass.");
		expect(updateLine("<details><summary>Result</summary>x</details>\nDone.")).toBe("Done.");
		expect(updateLine("Renamed my_var_name, e.g. in the parser. Then tests.")).toBe("Renamed my_var_name, e.g. in the parser.");
		expect(updateLine("## Summary\n\nShipped the fix.")).toBe("Shipped the fix.");
		expect(updateLine("## Summary")).toBe("Summary");
		expect(updateLine("y".repeat(300))).toBe(`${"y".repeat(119)}…`);
		expect(updateLine("   \n  ")).toBeUndefined();
	});

	it("reads the start of the agent's reply to the last prompt, however long the reply", async () => {
		const dir = makeTmp("deck-push-reply-");
		const file = path.join(dir, "session.jsonl");
		const row = (role: string, content: unknown) => JSON.stringify({ type: "message", message: { role, content } });
		fs.writeFileSync(file, `${[row("user", "go"), row("assistant", [{ type: "text", text: `Finished writing sample questions. ${"x".repeat(7000)} tail` }])].join("\n")}\n`);
		expect(updateLine(await readLatestAgentReply(file))).toBe("Finished writing sample questions.");
		// A newer prompt with no answer yet, or an answer that ended on a tool call, has no update to report.
		fs.appendFileSync(file, `${row("user", "next")}\n`);
		expect(await readLatestAgentReply(file)).toBeUndefined();
		fs.appendFileSync(file, `${row("assistant", [{ type: "toolCall", name: "bash" }])}\n`);
		expect(await readLatestAgentReply(file)).toBeUndefined();
	});

	it("removes a subscription on 404 or 410, keeps it on 5xx and timeouts, never retries, and never lets one failure block another", async () => {
		const f = await senderFixture({ timeoutMs: 400 });
		await f.subscribe("/ok");
		await f.subscribe("/missing", 404);
		await f.subscribe("/gone", 410);
		await f.subscribe("/broken", 503);
		await f.subscribe("/slow", "hang");
		await f.subscribe("/ok2");

		let settled = false;
		const pending = f.sender.notify(notifyEvent("s", "turn-finished", { title: "T" })).then(() => {
			settled = true;
		});
		// Both healthy phones are served while the hanging push service is still unanswered.
		await until(() => f.service.pushesTo("/ok").length === 1 && f.service.pushesTo("/ok2").length === 1, "healthy deliveries");
		expect(settled).toBe(false);
		await pending;

		const remaining = (await f.store.list()).map(s => new URL(s.endpoint).pathname).sort();
		expect(remaining).toEqual(["/broken", "/ok", "/ok2", "/slow"]);
		// Exactly one request per subscription: no retry after 503, 404, 410 or the timeout.
		expect([...f.service.requests].sort()).toEqual(["/broken", "/gone", "/missing", "/ok", "/ok2", "/slow"]);
		expect(f.service.rejections).toEqual([]);
		expect(f.logs.some(line => line.includes("503"))).toBe(true);
	});

	it("an unreachable push service is a logged failure for that subscription only, which stays stored", async () => {
		const f = await senderFixture({
			wrapFetch: inner => (url, init) => (url.endsWith("/never") ? Promise.reject(new Error("connect ECONNREFUSED")) : inner(url, init)),
		});
		await f.subscribe("/never");
		await f.subscribe("/ok");
		await f.sender.notify(notifyEvent("s", "turn-finished"));
		expect(f.service.pushesTo("/ok")).toHaveLength(1);
		expect(f.logs.some(line => line.includes("ECONNREFUSED"))).toBe(true);
		expect((await f.store.list()).map(s => new URL(s.endpoint).pathname).sort()).toEqual(["/never", "/ok"]);
	});
});
describe("answerable push payloads", () => {
	it("offers only approve-once and deny for the newest approval, and shows what is being approved", async () => {
		const f = await senderFixture({
			listUiRequests: async () => [
				{
					reqId: "older",
					kind: "select",
					title: "Old question",
					options: [{ label: "Old yes" }, { label: "Old no" }],
					at: 10,
				},
				{
					reqId: "newest",
					kind: "select",
					title: "Approve file access?",
					options: [{ label: "Always approve this directory" }, { label: "Approve Once" }, { label: "Deny" }],
					at: 20,
				},
			],
		});
		await f.subscribe("/phone");
		await f.sender.notify(notifyEvent("session", "needs-approval"));

		const [push] = f.service.pushesTo("/phone");
		expect(push!.payload.choices).toEqual(["Approve Once", "Deny"]);
		expect(push!.payload.body).toBe("Approve file access?");
		expect(push!.payload.reqId).toBe("newest");
		const token = push!.payload.answerToken!;
		expect(Buffer.from(token, "base64url").byteLength).toBe(32);
		expect(f.logs.every(line => !line.includes(token))).toBe(true);
	});

	it("keeps tap-to-open for a newer editor request instead of answering an older select", async () => {
		const f = await senderFixture({
			listUiRequests: async () => [
				{ reqId: "older", kind: "select", title: "Pick", options: [{ label: "A" }, { label: "B" }], at: 10 },
				{ reqId: "newest", kind: "editor", title: "Explain", prefill: "", at: 20 },
			],
		});
		await f.subscribe("/phone");
		await f.sender.notify(notifyEvent("session", "needs-answer"));
		expect(f.service.pushesTo("/phone")[0]!.payload.choices).toBeUndefined();
	});

	it("keeps tap-to-open when the newest select has more than three options", async () => {
		const f = await senderFixture({
			listUiRequests: async () => [{
				reqId: "many",
				kind: "select",
				title: "Pick",
				options: [{ label: "A" }, { label: "B" }, { label: "C" }, { label: "D" }],
				at: 20,
			}],
		});
		await f.subscribe("/phone");
		await f.sender.notify(notifyEvent("session", "needs-answer"));
		expect(f.service.pushesTo("/phone")[0]!.payload.choices).toBeUndefined();
	});

	it("keeps tap-to-open for multi-select requests", async () => {
		const f = await senderFixture({
			listUiRequests: async () => [{
				reqId: "multi",
				kind: "select",
				title: "Pick several",
				options: [{ label: "A" }, { label: "B" }],
				checkedIndices: [],
				markableCount: 2,
				at: 20,
			}],
		});
		await f.subscribe("/phone");
		await f.sender.notify(notifyEvent("session", "needs-answer"));
		expect(f.service.pushesTo("/phone")[0]!.payload.choices).toBeUndefined();
	});
});


describe("push coalescing", () => {
	it("sends at most one push per session and reason per window, independently across sessions and reasons", async () => {
		const f = await senderFixture();
		await f.subscribe("/phone");
		const sent = () => f.service.pushesTo("/phone").map(p => p.payload.tag);

		await f.sender.notify(notifyEvent("s1", "turn-finished"));
		f.clock.now += 29_999;
		await f.sender.notify(notifyEvent("s1", "turn-finished"));
		expect(sent()).toEqual(["s1:turn-finished"]);

		await f.sender.notify(notifyEvent("s1", "needs-answer"));
		await f.sender.notify(notifyEvent("s2", "turn-finished"));
		await f.sender.crashed(crashEvent("s1"));
		await f.sender.crashed(crashEvent("s1"));
		expect(sent()).toEqual(["s1:turn-finished", "s1:needs-answer", "s2:turn-finished", "s1:worker-crashed"]);

		f.clock.now += 1; // the first push is now exactly 30 s old
		await f.sender.notify(notifyEvent("s1", "turn-finished"));
		expect(sent().filter(tag => tag === "s1:turn-finished")).toHaveLength(2);
	});

	it("coalesces simultaneous duplicates, and an event with no subscriber does not silence a subscription added right after", async () => {
		const f = await senderFixture();
		await f.sender.notify(notifyEvent("s1", "turn-finished")); // nobody subscribed yet
		await f.subscribe("/phone");
		await Promise.all([f.sender.notify(notifyEvent("s1", "turn-finished")), f.sender.notify(notifyEvent("s1", "turn-finished"))]);
		expect(f.service.pushesTo("/phone")).toHaveLength(1);
	});
});

describe("VAPID key", () => {
	it("is generated on first run with mode 0600, reused after restart, tightened if loosened, and never logged", async () => {
		const f = await senderFixture();
		const file = path.join(f.stateDir, "vapid-keys.json");
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);
		const stored = JSON.parse(fs.readFileSync(file, "utf8")) as { publicKey: string; privateKey: string };
		expect(stored.publicKey).toBe(f.sender.publicKey);

		fs.chmodSync(file, 0o644);
		const again = await PushSender.open({ stateDir: f.stateDir, store: f.store });
		senders.push(again);
		expect(again.publicKey).toBe(f.sender.publicKey);
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);

		await f.subscribe("/ok");
		await f.subscribe("/bad", 503);
		await f.sender.notify(notifyEvent("s", "turn-finished"));
		for (const line of f.logs) expect(line).not.toContain(stored.privateKey);
		expect(f.logs.length).toBeGreaterThan(0);
	});

	it("refuses to start on a corrupt key file instead of replacing it (which would orphan every subscription)", async () => {
		const stateDir = makeTmp("deck-push-state-");
		const file = path.join(stateDir, "vapid-keys.json");
		fs.writeFileSync(file, "{not json");
		await expect(PushSender.open({ stateDir, store: new PushStore(stateDir) })).rejects.toThrow(/not valid JSON/);
		fs.writeFileSync(file, JSON.stringify({ publicKey: "AAAA", privateKey: "BBBB" }));
		await expect(PushSender.open({ stateDir, store: new PushStore(stateDir) })).rejects.toThrow(/VAPID key pair/);
		expect(fs.readFileSync(file, "utf8")).toContain("AAAA");
	});
});

describe("daemon push wiring", () => {
	async function pushDaemon(options: Parameters<typeof startTestDaemon>[0] = {}) {
		let key = "";
		const service = new FakePushService(() => key);
		services.push(service);
		const t = await startTestDaemon({ pushFetch: service.fetch, pushTimeoutMs: 1_000, ...options });
		key = ((await (await t.get("/api/push/public-key")).json()) as PushPublicKeyResponse).publicKey;
		return { t, service };
	}

	async function addSubscription(t: TestDaemon, service: FakePushService, pathname: string, behavior?: Parameters<FakePushService["subscribe"]>[1]) {
		const subscriber = service.subscribe(pathname, behavior);
		const res = await t.post("/api/push/subscribe", { endpoint: subscriber.endpoint, keys: subscriber.keys, label: "test" });
		expect(res.status).toBe(204);
		return subscriber;
	}

	it("GET /api/push/public-key returns the stored VAPID public key (only the public half)", async () => {
		const { t } = await pushDaemon();
		const res = await t.get("/api/push/public-key");
		expect(res.status).toBe(200);
		const text = await res.text();
		const stored = JSON.parse(fs.readFileSync(path.join(t.stateDir, "vapid-keys.json"), "utf8")) as { publicKey: string; privateKey: string };
		expect(JSON.parse(text)).toEqual({ publicKey: stored.publicKey });
		expect(text).not.toContain(stored.privateKey);
		expect(Buffer.from(stored.publicKey, "base64url").byteLength).toBe(65);
		expect((await t.post("/api/push/public-key", {})).status).toBe(405);
	});
	it("enforces the configured owner identity on push answers", async () => {
		const { t } = await pushDaemon({ owner: "owner@example.test" });
		const response = await t.post(
			"/api/push/answer",
			{ token: "not-a-real-token", value: "Approve" },
			{ "Tailscale-User-Login": "other@example.test" },
		);
		expect(response.status).toBe(401);
		const optionsResponse = await t.post(
			"/api/push/answer-options",
			{ sessionId: "session-1", reason: "needs-answer" },
			{ "Tailscale-User-Login": "other@example.test" },
		);
		expect(optionsResponse.status).toBe(401);
	});


	it("a worker notify becomes one push with the session title, without the worker's summary text", async () => {
		const script = JSON.stringify([
			{ at: 150, emit: { t: "notify", reason: "needs-answer", summary: "SECRET: rm -rf output of the tool" } },
			{ at: 170, emit: { t: "notify", reason: "needs-answer", summary: "SECRET again" } },
		]);
		const { t, service } = await pushDaemon({ workerFlags: ["--script", script] });
		await addSubscription(t, service, "/phone");
		const res = await t.post("/api/sessions", { cwd: t.dir });
		const session = (await res.json()) as SessionSummary;
		await until(() => service.pushesTo("/phone").length > 0, "needs-answer push");
		await Bun.sleep(150); // the second notify, 20 ms later, is coalesced
		const pushes = service.pushesTo("/phone");
		expect(pushes).toHaveLength(1);
		expect(pushes[0]!.payload).toEqual({
			reason: "needs-answer",
			sessionId: session.id,
			title: session.title!,
			body: "Needs your answer",
			tag: `${session.id}:needs-answer`,
			url: `/#session=${session.id}`,
		});
		expect(pushes[0]!.text).not.toContain("SECRET");
		expect(service.rejections).toEqual([]);
	});

	it("a worker crash sends a worker-crashed push, once for a crash loop within the window", async () => {
		const { t, service } = await pushDaemon({ workerFlags: ["--crash-after", "100"] });
		await addSubscription(t, service, "/phone");
		const session = (await (await t.post("/api/sessions", { cwd: t.dir })).json()) as SessionSummary;
		// restartBackoffMs [30, 60] in the harness: the worker crashes three times in a row.
		await until(async () => {
			const health = (await (await t.get("/api/health")).json()) as { workers: Array<{ restarts: number; state: string }> };
			return health.workers[0]?.restarts === 2 && health.workers[0]?.state === "crashed";
		}, "three crashes");
		await until(() => service.pushesTo("/phone").length > 0, "crash push");
		const pushes = service.pushesTo("/phone");
		expect(pushes).toHaveLength(1);
		expect(pushes[0]!.payload.reason).toBe("worker-crashed");
		expect(pushes[0]!.payload.body).toBe("Session crashed");
		expect(pushes[0]!.payload.sessionId).toBe(session.id);
	});

	it("DELETE /api/push/subscribe removes by endpoint (idempotent) and validates the body", async () => {
		const { t, service } = await pushDaemon();
		const a = await addSubscription(t, service, "/a");
		await addSubscription(t, service, "/b");
		const file = path.join(t.stateDir, "push-subscriptions.json");
		const endpoints = () => (JSON.parse(fs.readFileSync(file, "utf8")) as Array<{ endpoint: string }>).map(s => s.endpoint);
		expect((await t.del("/api/push/subscribe")).status).toBe(400);
		expect(
			(await fetch(`${t.url}/api/push/subscribe`, {
				method: "DELETE",
				headers: { Cookie: t.cookie, "Content-Type": "application/json" },
				body: JSON.stringify({ endpoint: a.endpoint }),
			})).status,
		).toBe(204);
		expect(endpoints()).toEqual(["https://push.test.invalid/b"]);
		expect(
			(await fetch(`${t.url}/api/push/subscribe`, {
				method: "DELETE",
				headers: { Cookie: t.cookie, "Content-Type": "application/json" },
				body: JSON.stringify({ endpoint: a.endpoint }),
			})).status,
		).toBe(204);
		expect(
			(await fetch(`${t.url}/api/push/subscribe`, {
				method: "DELETE",
				headers: { Cookie: t.cookie, "Content-Type": "application/json" },
				body: JSON.stringify({ endpoint: 5 }),
			})).status,
		).toBe(400);
		expect(endpoints()).toEqual(["https://push.test.invalid/b"]);
	});

	it("POST /api/push/test is 409 with no subscription, 204 once a push service accepts, 502 when none does", async () => {
		const { t, service } = await pushDaemon();
		expect((await t.post("/api/push/test")).status).toBe(409);

		await addSubscription(t, service, "/phone");
		expect((await t.post("/api/push/test")).status).toBe(204);
		expect((await t.post("/api/push/test")).status).toBe(204); // not coalesced: a user pressing the button wants a push
		expect(service.pushesTo("/phone").map(p => p.payload.body)).toEqual(["Test notification", "Test notification"]);

		const { t: t2, service: service2 } = await pushDaemon();
		await addSubscription(t2, service2, "/down", 503);
		const failed = await t2.post("/api/push/test");
		expect(failed.status).toBe(502);
		expect(((await failed.json()) as { code: string }).code).toBe("internal");
		expect((await t2.get("/api/push/test")).status).toBe(405);
	});

	it("rejects a subscription whose keys cannot encrypt (wrong lengths) at subscribe time", async () => {
		const { t, service } = await pushDaemon();
		const good = service.subscribe("/x");
		const short = { endpoint: good.endpoint, keys: { p256dh: Buffer.alloc(33, 4).toString("base64url"), auth: good.keys.auth } };
		expect((await t.post("/api/push/subscribe", short)).status).toBe(400);
		const badAuth = { endpoint: good.endpoint, keys: { p256dh: good.keys.p256dh, auth: Buffer.alloc(8).toString("base64url") } };
		expect((await t.post("/api/push/subscribe", badAuth)).status).toBe(400);
	});
});
