import { describe, expect, it } from "bun:test";
import type { GitFileDiff, GitStatusSnapshot, PendingUiRequest, SessionSummary } from "@omp-console/protocol";
import type { CollabUiRequest, CollabUiRequestDraft } from "@oh-my-pi/pi-wire";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import type { MockRoom } from "../dev/mock-room";
import { fixtureEntries } from "../dev/fixture";
import { createSessionOpsMock, type MockSessionOps, type MockSessionOpsSession } from "../dev/mock-session-ops";

function harness(): {
	ops: MockSessionOps;
	summary: SessionSummary;
	responses: Array<{ reqId: number; value: string | null }>;
	appendUserPrompt(): void;
} {
	let pending: CollabUiRequest | null = {
		reqId: 9,
		kind: "select",
		title: "Review the plan excerpt",
		options: ["Execute", "Refine", "Save"],
		initialIndex: 1,
	};
	const responses: Array<{ reqId: number; value: string | null }> = [];
	const entries: SessionEntry[] = fixtureEntries.slice(0, 2);
	const room: Pick<MockRoom, "roomId" | "status" | "participants" | "append" | "lastEntryId" | "transcriptEntries" | "rewindTo" | "pendingUiRequest" | "answerUiRequest" | "ask"> = {
		roomId: "room-1",
		status() { return { streaming: false, entryCount: entries.length, agentCount: 0, guests: 0, asking: pending !== null }; },
		participants() { return [{ name: "Deck", role: "host" }]; },
		append(entry) { entries.push(entry); },
		lastEntryId() { return entries.at(-1)?.id ?? null; },
		transcriptEntries() { return entries; },
		rewindTo(entryId) { return entries.find(entry => entry.id === entryId) ?? null; },
		pendingUiRequest() { return pending; },
		ask(draft: CollabUiRequestDraft) { pending = { ...draft, reqId: (pending?.reqId ?? 9) + 1 }; },
		answerUiRequest(reqId, value) {
			if (pending?.reqId !== reqId) return false;
			pending = null;
			responses.push({ reqId, value });
			return true;
		},
	};
	const summary: SessionSummary = {
		id: "session-1",
		title: "Session",
		cwd: "/work",
		state: "idle",
		createdAt: 1,
		lastActivityAt: 1,
		agentCount: 0,
		goalActive: false,
		awaitingAnswer: true,
	};
	const session: MockSessionOpsSession = {
		summary,
		room,
		setGoal() {},
		setLoopMode(status) { summary.loopMode = status; },
		setVibeMode(status) { summary.vibeMode = status; },
	};
	const ops = createSessionOpsMock({ getSession: id => id === summary.id ? session : undefined });
	return {
		summary,
		ops,
		responses,
		appendUserPrompt() {
			const userEntry = fixtureEntries[0]!;
			entries.push({ ...userEntry, id: "newer-user-prompt", parentId: entries.at(-1)?.id ?? null });
		},
	};
}

async function postOp(ops: MockSessionOps, operation: unknown, signal?: AbortSignal): Promise<Response> {
	const request = new Request("http://deck.test/api/sessions/session-1/ops", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(operation),
		...(signal === undefined ? {} : { signal }),
	});
	return ops.handle(request, "/sessions/session-1/ops");
}

describe("mock ui-request and quick-reply operations", () => {
	it("serializes a pending choice and removes it after an answer", async () => {
		const { ops, responses } = harness();
		const open = await postOp(ops, { op: "ui-requests" });
		const openBody = await open.json() as { ok: boolean; uiRequests: PendingUiRequest[] };
		expect(openBody.uiRequests[0]).toMatchObject({
			reqId: "9",
			kind: "select",
			initialIndex: 1,
			options: [{ label: "Execute" }, { label: "Refine" }, { label: "Save" }],
		});

		const answered = await postOp(ops, { op: "ui-answer", reqId: "9", value: "Refine" });
		expect(answered.status).toBe(200);
		expect(responses).toEqual([{ reqId: 9, value: "Refine" }]);
		const closedBody = await (await postOp(ops, { op: "ui-requests" })).json() as { uiRequests: PendingUiRequest[] };
		expect(closedBody.uiRequests).toEqual([]);
	});

	it("rejects stale answer ids and only generates replies for the current assistant entry", async () => {
		const { ops, responses, appendUserPrompt } = harness();
		const staleAnswer = await postOp(ops, { op: "ui-answer", reqId: "8", value: "Execute" });
		expect(staleAnswer.status).toBe(409);
		expect(responses).toEqual([]);

		const current = await (await postOp(ops, { op: "quick-replies", entryId: "e02" })).json() as { replies: string[] };
		const stale = await (await postOp(ops, { op: "quick-replies", entryId: "e01" })).json() as { replies: string[] };
		expect(current.replies).toHaveLength(10);
		expect(stale.replies).toEqual([]);
		appendUserPrompt();
		const afterPrompt = await (await postOp(ops, { op: "quick-replies", entryId: "e02" })).json() as { replies: string[] };
		expect(afterPrompt.replies).toEqual([]);
	});
	it("updates loop and Vibe mode states consumed by the session list", async () => {
		const { ops, summary } = harness();
		const loopOn = await postOp(ops, { op: "loop-mode", action: "toggle", args: "2 repeat this" });
		expect(loopOn.status).toBe(200);
		expect(await loopOn.json()).toEqual({
			ok: true,
			loopMode: { active: true, iteration: 0, waitingForPrompt: false },
		});
		expect(summary.loopMode?.active).toBe(true);
		expect((await (await postOp(ops, { op: "loop-mode", action: "status" })).json())).toMatchObject({
			loopMode: { active: true, iteration: 0 },
		});
		await postOp(ops, { op: "loop-mode", action: "disable" });
		expect(summary.loopMode?.active).toBe(false);

		const vibeOn = await postOp(ops, { op: "vibe-mode", action: "toggle" });
		expect(await vibeOn.json()).toEqual({ ok: true, vibeMode: { active: true, workers: [] } });
		expect(summary.vibeMode?.active).toBe(true);
		await postOp(ops, { op: "vibe-mode", action: "toggle" });
		expect(summary.vibeMode?.active).toBe(false);
	});
});

describe("mock skill script approval", () => {
	it("does not install a scripted skill until a guest explicitly approves the package scripts", async () => {
		const { ops, responses } = harness();
		const install = postOp(ops, { op: "skills-install", specs: ["@omp-console/review"], global: false, approvalId: "skill-install-1" });
		const pending = await (await postOp(ops, { op: "ui-requests" })).json() as { uiRequests: PendingUiRequest[] };
		expect(pending.uiRequests[0]).toMatchObject({
			reqId: "10",
			title: "Install skill with scripts?\n@omp-console/review@1.0.0 scripts:\n- postinstall: add a local review command to this project.\n\n[omp-console-skill-approval:skill-install-1]",
			options: [{ label: "Yes" }, { label: "No" }],
		});

		const before = await (await postOp(ops, { op: "skills-installed" })).json() as { installedSkills: unknown[] };
		expect(before.installedSkills).toEqual([]);
		expect(responses).toEqual([]);
		expect((await postOp(ops, { op: "ui-answer", reqId: "10", value: "Yes" })).status).toBe(200);
		const installed = await install;
		expect(await installed.json()).toMatchObject({ ok: true, installedSkills: [{ id: "@omp-console/review" }] });
	});

	it("cancels an abandoned approval and rejects a later answer", async () => {
		const { ops, responses } = harness();
		const controller = new AbortController();
		const install = postOp(ops, { op: "skills-install", specs: ["@omp-console/review"], global: false, approvalId: "abandoned-install" }, controller.signal);
		const pending = await (await postOp(ops, { op: "ui-requests" })).json() as { uiRequests: PendingUiRequest[] };
		const request = pending.uiRequests[0];
		if (!request) throw new Error("the mock install should ask for script approval");

		controller.abort();
		expect((await install).status).toBe(409);
		expect(responses).toContainEqual({ reqId: Number(request.reqId), value: "No" });
		expect((await (await postOp(ops, { op: "ui-requests" })).json() as { uiRequests: PendingUiRequest[] }).uiRequests).toEqual([]);
		expect((await postOp(ops, { op: "ui-answer", reqId: request.reqId, value: "Yes" })).status).toBe(409);
		expect((await (await postOp(ops, { op: "skills-installed" })).json() as { installedSkills: unknown[] }).installedSkills).toEqual([]);
	});
});
describe("mock Git session operations", () => {
	it("stages, commits and opens committed revisions as read-only", async () => {
		const { ops } = harness();
		const working = await (await postOp(ops, { op: "git-view" })).json() as { git: GitStatusSnapshot };
		expect(working.git.unstaged.map(file => file.path)).toEqual(["README.md"]);

		const stage = await (await postOp(ops, { op: "git-stage", action: "stage", paths: ["README.md"] })).json() as { git: GitStatusSnapshot };
		expect(stage.git.staged.map(file => file.path)).toEqual(["README.md"]);
		expect(stage.git.unstaged).toEqual([]);

		const commit = await (await postOp(ops, { op: "git-commit", message: "Mock local commit" })).json() as { git: GitStatusSnapshot };
		expect(commit.git.staged).toEqual([]);
		expect(commit.git.headCommit?.subject).toBe("Mock local commit");
		expect(commit.git.commitFiles.map(file => file.path)).toEqual(["README.md"]);

		const revision = await (await postOp(ops, { op: "git-view", revision: "HEAD~1" })).json() as { git: GitStatusSnapshot };
		expect(revision.git).toMatchObject({ readOnly: true, revision: "HEAD~1", staged: [], unstaged: [] });
		const diff = await (await postOp(ops, { op: "git-diff", path: "README.md", area: "commit", revision: "HEAD~1" })).json() as { gitDiff: GitFileDiff };
		expect(diff.gitDiff).toMatchObject({
			kind: "text",
			hunks: [{
				header: "@@ -1,1 +1,1 @@",
				lines: [
					{ kind: "del", text: "README.md before" },
					{ kind: "add", text: "README.md after" },
				],
			}],
		});
	});
});

describe("mock live and debug operations", () => {
	it("tracks live mode and drives a confirmed debug session through inspection, control, and termination", async () => {
		const { ops, summary } = harness();
		expect(await (await postOp(ops, { op: "live-mode", action: "status" })).json()).toMatchObject({
			ok: true,
			liveMode: { active: false, phase: "idle" },
		});
		const missingOffer = await postOp(ops, { op: "live-mode", action: "start" });
		expect(missingOffer.status).toBe(400);
		const offer = "v=0\r\na=setup:actpass\r\na=sendrecv\r\n";
		expect(await (await postOp(ops, { op: "live-mode", action: "start", offer })).json()).toMatchObject({
			ok: true,
			liveMode: { active: true, phase: "listening" },
			browserAnswer: "v=0\r\na=setup:active\r\na=recvonly\r\n",
		});
		expect(summary.liveMode).toMatchObject({ active: true, phase: "listening" });
		expect(await (await postOp(ops, { op: "live-mode", action: "stop" })).json()).toMatchObject({
			ok: true,
			liveMode: { active: false, phase: "idle" },
		});

		const adapters = await (await postOp(ops, { op: "debug", action: "adapters" })).json() as {
			debugAdapters: Array<{ name: string; available: boolean }>;
		};
		expect(adapters.debugAdapters).toEqual([
			expect.objectContaining({ name: "mock-dap", available: true }),
			expect.objectContaining({ name: "missing-dap", available: false }),
		]);
		expect((await postOp(ops, { op: "debug", action: "launch", program: "sample.js", confirmed: false })).status).toBe(400);
		const launch = await (await postOp(ops, {
			op: "debug",
			action: "launch",
			program: "sample.js",
			adapter: "mock-dap",
			confirmed: true,
		})).json() as { debugSession: { id: string; status: string } };
		expect(launch.debugSession).toMatchObject({ id: "mock-debug-1", status: "stopped" });
		expect(await (await postOp(ops, { op: "debug", action: "threads" })).json()).toMatchObject({
			debugThreads: [{ id: 1, name: "main thread" }],
		});
		expect(await (await postOp(ops, { op: "debug", action: "stack" })).json()).toMatchObject({
			debugStack: [{ name: "main", source: { name: "sample.js" } }],
		});
		expect(await (await postOp(ops, { op: "debug", action: "variables", reference: 10 })).json()).toMatchObject({
			debugVariables: [{ name: "value", value: "42" }],
		});
		expect(await (await postOp(ops, { op: "debug", action: "continue" })).json()).toMatchObject({
			debugSession: { status: "running" },
		});
		expect(await (await postOp(ops, { op: "debug", action: "pause" })).json()).toMatchObject({
			debugSession: { status: "stopped", stopReason: "pause" },
		});
		expect((await postOp(ops, { op: "debug", action: "attach", port: 4711, confirmed: false })).status).toBe(400);
		expect(await (await postOp(ops, { op: "debug", action: "terminate" })).json()).toMatchObject({
			debugSessions: [{ id: "mock-debug-fixture" }],
			activeSessionId: "mock-debug-fixture",
		});
		expect(await (await postOp(ops, { op: "debug", action: "sessions" })).json()).toMatchObject({
			debugSessions: [{ id: "mock-debug-fixture" }],
		});
	});
	it("streams diagnostic snapshots and requires confirmation before cache removal", async () => {
		const { ops } = harness();
		const first = await (await postOp(ops, { op: "debug-diagnostics", action: "logs" })).json() as {
			debugDiagnostic: { text: string };
		};
		const second = await (await postOp(ops, { op: "debug-diagnostics", action: "logs" })).json() as {
			debugDiagnostic: { text: string };
		};
		expect(first.debugDiagnostic.text).not.toBe(second.debugDiagnostic.text);

		const confirmation = await (await postOp(ops, { op: "debug-diagnostics", action: "clear-cache" })).json() as {
			debugDiagnostic: { confirmationRequired?: boolean };
		};
		expect(confirmation.debugDiagnostic.confirmationRequired).toBe(true);
		const cleared = await (await postOp(ops, { op: "debug-diagnostics", action: "clear-cache", confirmed: true })).json() as {
			debugDiagnostic: { text?: string; confirmationRequired?: boolean };
		};
		expect(cleared.debugDiagnostic.confirmationRequired).toBeUndefined();
		expect(cleared.debugDiagnostic.text).toBe("Mock cache cleared.");

		const remoteConfirmation = await (await postOp(ops, { op: "debug-diagnostics", action: "remote-debugger" })).json() as {
			debugDiagnostic: { confirmationRequired?: boolean; text?: string };
		};
		expect(remoteConfirmation.debugDiagnostic.confirmationRequired).toBe(true);
		expect(remoteConfirmation.debugDiagnostic.text).toContain("unauthenticated");
		expect(remoteConfirmation.debugDiagnostic.text).toContain("127.0.0.1");
		const remoteStarted = await (await postOp(ops, { op: "debug-diagnostics", action: "remote-debugger", confirmed: true })).json() as {
			debugDiagnostic: { confirmationRequired?: boolean; text?: string; remoteDebugger?: { host: string; port: number } };
		};
		expect(remoteStarted.debugDiagnostic.confirmationRequired).toBeUndefined();
		expect(remoteStarted.debugDiagnostic.text).toContain("local process");
		expect(remoteStarted.debugDiagnostic.text).toContain("execute code");
		expect(remoteStarted.debugDiagnostic.remoteDebugger).toMatchObject({ host: "127.0.0.1", port: 9229 });

		const report = await (await postOp(ops, { op: "debug-diagnostics", action: "dump" })).json() as {
			debugDiagnostic: { download?: { path: string; byteLength: number; base64: string } };
		};
		expect(report.debugDiagnostic.download).toMatchObject({ path: "mock://reports/dump-mock.tar.gz" });
		if (!report.debugDiagnostic.download) throw new Error("mock diagnostics returned no report download");
		expect(Buffer.from(report.debugDiagnostic.download.base64, "base64").toString()).toContain("Mock dump artifact");
		expect(report.debugDiagnostic.download.byteLength).toBe(Buffer.from(report.debugDiagnostic.download.base64, "base64").byteLength);
	});
});
