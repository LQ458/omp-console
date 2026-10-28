/**
 * Pure helpers behind the wave-2 worker commands: what may leave the process (usage reports), what the summariser
 * is allowed to see (transcript excerpt) and which extension payloads count as omp console panels.
 */
import { describe, expect, test } from "bun:test";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { decodeCommand, decodeSessionOp } from "../src/decode";
import { parseDeckPanel } from "../src/ext-ui";
import { buildTranscriptExcerpt, parseKeyPoints } from "../src/key-points";
import { QuotaGate } from "../src/quota-gate";
import { sanitizeUsageReports } from "../src/usage-report";

// Fake, secret-shaped strings: a JWT-like triple and a provider-prefixed key.
const JWT = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJmYWtlLXVzZXIifQ", "ZmFrZS1zaWduYXR1cmU"].join(".");
const KEY = "sk-ant-api03-fakefakefakefakefakefake";

describe("usage reports leave the worker without anything credential-shaped", () => {
	const report: UsageReport = {
		provider: "anthropic",
		fetchedAt: 1_700_000_000_000,
		limits: [
			{
				id: "5h",
				label: "5 Hour",
				scope: { provider: "anthropic", accountId: "acct-1", windowId: "5h", modelId: "opus" },
				window: { id: "5h", label: "5 Hour", durationMs: 18_000_000, resetsAt: 1_700_000_900_000 },
				amount: { used: 42, limit: 100, usedFraction: 0.42, unit: "percent" },
				status: "ok",
				notes: [`served with ${KEY}`],
			},
		],
		resetCredits: { availableCount: 2, eligible: true, credits: [{ id: "grant-secret-id", title: "Reset" }] },
		metadata: { email: "alice@example.com", endpoint: `https://api.example.com/usage?access_token=${JWT}`, source: "ratelimit-headers", token: JWT },
		raw: { access_token: JWT, refresh: KEY },
	};

	test("keeps provider, windows, amounts, resets and the account label; drops raw payloads, credits and endpoints", () => {
		const [out] = sanitizeUsageReports([report]) as Array<Record<string, unknown>>;
		const json = JSON.stringify(out);
		expect(json).not.toContain(JWT);
		expect(json).not.toContain(KEY);
		expect(json).not.toContain("grant-secret-id");
		expect(json).not.toContain("access_token");
		expect(out).not.toHaveProperty("raw");
		expect(out).toMatchObject({
			provider: "anthropic",
			fetchedAt: 1_700_000_000_000,
			resetCredits: { availableCount: 2, eligible: true },
			metadata: { email: "alice@example.com", source: "ratelimit-headers" },
		});
		const limit = (out.limits as Array<Record<string, unknown>>)[0]!;
		expect(limit).toMatchObject({
			id: "5h",
			scope: { provider: "anthropic", accountId: "acct-1", windowId: "5h" },
			window: { id: "5h", durationMs: 18_000_000, resetsAt: 1_700_000_900_000 },
			amount: { used: 42, limit: 100, unit: "percent" },
			status: "ok",
		});
		// A note that quotes a key is replaced, not passed on.
		expect(limit.notes).toEqual(["[redacted]"]);
	});

	test("no usage support (null) is an empty list", () => {
		expect(sanitizeUsageReports(null)).toEqual([]);
	});
});

describe("transcript excerpt", () => {
	const at = "2026-10-23T00:00:00.000Z";
	const user = (id: string, text: string): SessionEntry =>
		({ type: "message", id, parentId: null, timestamp: at, message: { role: "user", content: text, timestamp: 0 } }) as SessionEntry;
	const assistant = (id: string, text: string, tool?: { name: string; path: string }): SessionEntry =>
		({
			type: "message",
			id,
			parentId: null,
			timestamp: at,
			message: {
				role: "assistant",
				content: [
					...(text ? [{ type: "text", text }] : []),
					...(tool ? [{ type: "toolCall", id: `call-${id}`, name: tool.name, arguments: { path: tool.path } }] : []),
				],
			},
		}) as unknown as SessionEntry;
	const toolResult = (id: string, text: string): SessionEntry =>
		({ type: "message", id, parentId: null, timestamp: at, message: { role: "toolResult", toolName: "read", content: [{ type: "text", text }] } }) as unknown as SessionEntry;

	test("keeps the first request, the recent turns and tool targets; drops tool results", () => {
		const excerpt = buildTranscriptExcerpt([
			user("1", "Port the parser to Rust"),
			assistant("2", "Reading the module", { name: "read", path: "src/parser.ts" }),
			toolResult("3", "SECRET FILE CONTENT"),
			assistant("4", "Done"),
		]);
		expect(excerpt).toContain("First request:\nPort the parser to Rust");
		expect(excerpt).toContain("Tool: read src/parser.ts");
		expect(excerpt).toContain("Assistant: Done");
		expect(excerpt).not.toContain("SECRET FILE CONTENT");
	});

	test("a long session is cut from the middle: first request and newest turns survive within the budget", () => {
		const entries: SessionEntry[] = [user("0", "The original ask")];
		for (let i = 1; i <= 200; i++) entries.push(assistant(String(i), `turn ${i} `.repeat(40)));
		const excerpt = buildTranscriptExcerpt(entries, 3000);
		expect(excerpt.length).toBeLessThanOrEqual(3100);
		expect(excerpt).toContain("The original ask");
		expect(excerpt).toContain("[earlier turns omitted]");
		expect(excerpt).toContain("turn 200");
		expect(excerpt).not.toContain("turn 2 ");
	});

	test("nothing worth summarising is an empty excerpt", () => {
		expect(buildTranscriptExcerpt([])).toBe("");
		expect(buildTranscriptExcerpt([toolResult("1", "x")])).toBe("");
	});
});

describe("key points reply", () => {
	test("accepts a card inside a code fence, clamps list lengths and drops empty optional fields", () => {
		const reply = `\`\`\`json\n${JSON.stringify({
			title: "Port the parser",
			goal: "  ",
			decisions: Array.from({ length: 15 }, (_, i) => `decision ${i}`),
			files: ["a.ts"],
			openQuestions: [],
		})}\n\`\`\``;
		const card = parseKeyPoints("s1", reply, 42);
		expect(card.title).toBe("Port the parser");
		expect(card.decisions).toHaveLength(10);
		expect(card.goal).toBeUndefined();
		expect(card.outcome).toBeUndefined();
		expect(card.generatedAt).toBe(42);
	});

	test("a missing title or a non-array list is rejected", () => {
		expect(() => parseKeyPoints("s", JSON.stringify({ decisions: [], files: [], openQuestions: [] }), 1)).toThrow("title");
		expect(() => parseKeyPoints("s", JSON.stringify({ title: "t", decisions: [], files: "x", openQuestions: [] }), 1)).toThrow("files");
		expect(() => parseKeyPoints("s", "no json here", 1)).toThrow("JSON");
	});
});

describe("omp console panel descriptors", () => {
	test("every kind needs its own fields; a wrong type anywhere rejects the panel", () => {
		expect(parseDeckPanel({ kind: "list", title: "T", items: [{ label: "a" }, { label: "b", detail: "d" }] })).toEqual({ kind: "list", title: "T", items: [{ label: "a" }, { label: "b", detail: "d" }] });
		expect(parseDeckPanel({ kind: "table", title: "T", columns: ["a"], rows: [["1"], ["2"]] })).toMatchObject({ kind: "table" });
		expect(parseDeckPanel({ kind: "buttons", title: "T", buttons: [{ label: "Run", command: "/compact" }] })).toMatchObject({ kind: "buttons" });
		expect(parseDeckPanel({ kind: "markdown", title: "T", text: "# hi" })).toMatchObject({ kind: "markdown" });
		expect(parseDeckPanel({ kind: "progress", title: "T", value: "3", max: 10 })).toBeUndefined();
		expect(parseDeckPanel({ kind: "list", title: "T", items: [{ label: 1 }] })).toBeUndefined();
		expect(parseDeckPanel({ kind: "table", title: "T", columns: ["a"], rows: [[1]] })).toBeUndefined();
		expect(parseDeckPanel({ kind: "unknown", title: "T" })).toBeUndefined();
		expect(parseDeckPanel({ kind: "kv", rows: [] })).toBeUndefined();
	});
});

describe("worker command decoding", () => {
	test("quota-policy needs no id; session-op validates the op down to its fields", () => {
		expect(decodeCommand(JSON.stringify({ t: "quota-policy", providers: [{ provider: "anthropic", admitSpawns: false, holdPrompts: true, reason: "x" }] }))).toEqual({
			t: "quota-policy",
			providers: [{ provider: "anthropic", admitSpawns: false, holdPrompts: true, reason: "x" }],
		});
		expect(decodeCommand(JSON.stringify({ t: "quota-policy", providers: [{ provider: "anthropic", admitSpawns: "no" }] }))).toBeUndefined();
		expect(decodeCommand(JSON.stringify({ t: "cancel-session-op", id: "request-1" }))).toEqual({ t: "cancel-session-op", id: "request-1" });
		expect(decodeSessionOp({ op: "goal", action: "budget", tokenBudget: 0 })).toBeUndefined();
		expect(decodeSessionOp({ op: "goal", action: "budget", tokenBudget: 1.5 })).toBeUndefined();
		expect(decodeSessionOp({ op: "approval-mode", mode: "root" })).toBeUndefined();
		expect(decodeSessionOp({ op: "compact", mode: "snap" })).toEqual({ op: "compact", mode: "snap" });
		expect(decodeSessionOp({ op: "loop-mode", action: "toggle", args: "3 --until 'test -f done'" })).toEqual({
			op: "loop-mode",
			action: "toggle",
			args: "3 --until 'test -f done'",
		});
		expect(decodeSessionOp({ op: "loop-mode", action: "status" })).toEqual({ op: "loop-mode", action: "status" });
		expect(decodeSessionOp({ op: "vibe-mode", action: "disable" })).toEqual({ op: "vibe-mode", action: "disable" });
		expect(decodeSessionOp({ op: "vibe-mode", action: "toggle", args: 2 })).toBeUndefined();
		expect(decodeSessionOp({ op: "loop-mode", action: "toggle", args: "x".repeat(4001) })).toBeUndefined();
		expect(decodeSessionOp({ op: "dequeue", index: -1 })).toBeUndefined();
		expect(decodeSessionOp({ op: "todos", phases: [{ name: "p", tasks: [{ content: "c", status: "done" }] }] })).toBeUndefined();
		expect(decodeSessionOp({ op: "skills-search", query: "  lint  " })).toEqual({ op: "skills-search", query: "lint" });
		expect(decodeSessionOp({ op: "skills-install", specs: ["@omp-console/review"], global: false, approvalId: "install-1" })).toEqual({
			op: "skills-install",
			specs: ["@omp-console/review"],
			global: false,
			approvalId: "install-1",
		});
		expect(decodeSessionOp({ op: "skills-install", specs: ["@omp-console/review"], global: false, approvalId: "" })).toBeUndefined();
		expect(decodeSessionOp({ op: "skills-install", specs: [], global: false })).toBeUndefined();
		expect(decodeSessionOp({ op: "git-view", revision: "HEAD~1" })).toEqual({ op: "git-view", revision: "HEAD~1" });
		expect(decodeSessionOp({ op: "git-diff", path: "src/main.ts", area: "unstaged" })).toEqual({
			op: "git-diff",
			path: "src/main.ts",
			area: "unstaged",
		});
		expect(decodeSessionOp({ op: "git-stage", action: "stage", paths: ["src/main.ts"] })).toEqual({
			op: "git-stage",
			action: "stage",
			paths: ["src/main.ts"],
		});
		expect(decodeSessionOp({ op: "git-stage", action: "stage", paths: [] })).toBeUndefined();
		expect(decodeSessionOp({ op: "git-hunk", action: "stage", path: "src/main.ts", area: "unstaged", hunkIndex: 0, patchHash: "a".repeat(64) })).toEqual({
			op: "git-hunk",
			action: "stage",
			path: "src/main.ts",
			area: "unstaged",
			hunkIndex: 0,
			patchHash: "a".repeat(64),
		});
		expect(decodeSessionOp({ op: "git-hunk", action: "stage", path: "src/main.ts", area: "staged", hunkIndex: 0, patchHash: "a".repeat(64) })).toBeUndefined();
		expect(decodeSessionOp({ op: "git-hunk", action: "stage", path: "src/main.ts", area: "unstaged", hunkIndex: -1, patchHash: "invalid" })).toBeUndefined();
		expect(decodeSessionOp({ op: "git-commit", message: " " })).toBeUndefined();
		expect(decodeSessionOp({ op: "live-mode", action: "start", offer: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n" })).toEqual({
			op: "live-mode",
			action: "start",
			offer: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
		});
		expect(decodeSessionOp({ op: "live-mode", action: "start", offer: "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 111\r\n" })).toBeUndefined();
		expect(decodeSessionOp({ op: "live-mode", action: "start", offer: "v=1\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n" })).toBeUndefined();
		expect(decodeSessionOp({ op: "debug-diagnostics", action: "environment" })).toBeUndefined();

	});
});

describe("quota gate", () => {
	test("a waiter parks until its provider is admitted, others pass, and a flip back to blocking parks it again", async () => {
		const gate = new QuotaGate();
		gate.update([{ provider: "a", admitSpawns: false, holdPrompts: false }]);
		expect(await gate.wait("b", "spawn")).toBe("admitted");

		let outcome: string | undefined;
		const parked = gate.wait("a", "spawn").then(result => {
			outcome = result;
		});
		await Bun.sleep(20);
		expect(outcome).toBeUndefined();
		expect(gate.waiting).toBe(1);

		// A policy that admits `a` and blocks it again in the same breath (a later push) must not release the caller.
		gate.update([{ provider: "a", admitSpawns: false, holdPrompts: false }]);
		await Bun.sleep(20);
		expect(outcome).toBeUndefined();

		gate.update([{ provider: "a", admitSpawns: true, holdPrompts: false }]);
		await parked;
		expect(outcome).toBe("admitted");
		expect(gate.waiting).toBe(0);
		gate.close();
	});

	test("prompt holds and spawn holds are independent, and cancelling releases without admitting", async () => {
		const gate = new QuotaGate();
		gate.update([{ provider: "a", admitSpawns: true, holdPrompts: true }]);
		expect(gate.holdsSpawns("a")).toBe(false);
		expect(gate.holdsPrompts("a")).toBe(true);
		const parked = gate.wait("a", "prompt");
		gate.cancelWaiters();
		expect(await parked).toBe("cancelled");
		gate.close();
		expect(await gate.wait("a", "prompt")).toBe("admitted");
	});
});
