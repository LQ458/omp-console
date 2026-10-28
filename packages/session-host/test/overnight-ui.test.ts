import { describe, expect, it } from "bun:test";
import type { CollabGuestUiResult, CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import type { ExtensionApprovalPrompt } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { CollabUiRequestDraft } from "@oh-my-pi/pi-wire";
import { createGuestUiContext } from "../src/guest-ui";

function fixture(timeoutSec: number) {
	const requests: CollabUiRequestDraft[] = [];
	const answers: Array<{ question: string; answer: string }> = [];
	let timeoutCallback = false;
	let closed = 0;
	const host = {
		requestGuestUi(request: CollabUiRequestDraft, signal?: AbortSignal) {
			requests.push(request);
			const result = Promise.withResolvers<CollabGuestUiResult>();
			signal?.addEventListener("abort", () => result.resolve({ kind: "unavailable" }), { once: true });
			return result.promise;
		},
	} as unknown as CollabHost;
	const ui = createGuestUiContext({
		host: () => host,
		opened: () => requests.length,
		closed: () => closed++,
		askTimeoutSec: () => timeoutSec,
		autoAnswer: notice => answers.push({ question: notice.question, answer: notice.answer }),
	});
	return {
		ui,
		requests,
		answers,
		closed: () => closed,
		timeout: () => (timeoutCallback = true),
		timedOut: () => timeoutCallback,
	};
}

describe("overnight guest UI fallback", () => {
	it("times out an ask using its recommended option and publishes that answer", async () => {
		const test = fixture(0.005);
		const value = await test.ui.select("Which branch?", ["safe (Recommended)", "fast", "Other", "Ask the agent"], {
			initialIndex: 0,
			markableCount: 2,
			timeout: 5,
			onTimeout: test.timeout,
		});

		expect(value).toBe("safe");
		expect(test.timedOut()).toBe(true);
		expect(test.answers).toEqual([{ question: "Which branch?", answer: "safe" }]);
		expect(test.closed()).toBe(1);
	});

	it("auto-cancels confirmations and denies approvals when a dialog has no caller timeout", async () => {
		const confirmFixture = fixture(0.005);
		expect(await confirmFixture.ui.confirm("Continue?", "Run the action?")).toBe(false);
		expect(confirmFixture.answers[0]?.answer).toBe("cancelled/default");

		const approvalFixture = fixture(0.005);
		const prompt: ExtensionApprovalPrompt = { full: "Run command?", compact: "Run command?", grants: [{ scope: "target", label: "Approve file", alwaysLabel: "Always approve file" }] };
		expect(await approvalFixture.ui.approve!(prompt)).toBe("deny");
		expect(approvalFixture.answers[0]).toEqual({ question: prompt.full, answer: "Deny" });
		expect(confirmFixture.requests).toHaveLength(1);
		expect(approvalFixture.requests).toHaveLength(1);
	});
	it("waits for the overnight timeout and recommends an option when the host cannot queue a guest request", async () => {
		const answers: string[] = [];
		let timedOut = false;
		const ui = createGuestUiContext({
			host: () => ({ requestGuestUi: () => undefined }) as unknown as CollabHost,
			opened: () => 0,
			closed: () => {},
			askTimeoutSec: () => 0.005,
			autoAnswer: notice => answers.push(notice.answer),
		});
		const startedAt = Date.now();
		const answer = await ui.select("Which option?", ["alpha (Recommended)", "beta"], {
			initialIndex: 0,
			markableCount: 2,
			onTimeout: () => {
				timedOut = true;
			},
		});

		expect(answer).toBe("alpha");
		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(4);
		expect(timedOut).toBe(true);
		expect(answers).toEqual(["alpha"]);
	});
});
