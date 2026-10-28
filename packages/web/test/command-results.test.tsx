import { describe, expect, it, vi } from "bun:test";
import type { HostFrame, SessionHeader, SessionState } from "@oh-my-pi/pi-wire";
import { renderToStaticMarkup } from "react-dom/server";
import "./transcript-dom-shim";
import { CommandResults } from "../src/components/commands/CommandResults";
import { GuestClient } from "../src/lib/client";
import { expectCommandResult } from "../src/lib/command-results";
import { COLLAB_PROTO, encodeBase64Url } from "../src/lib/link";

const LINK = `command-results-room#${encodeBase64Url(new Uint8Array(32))}`;
const HEADER: SessionHeader = { type: "session", id: "session-1", timestamp: "2026-10-24T00:00:00Z", cwd: "/work" };
const STATE: SessionState = {
	isStreaming: false,
	queuedMessageCount: 0,
	cwd: "/work",
	participants: [{ name: "host", role: "host" }],
};
const welcome: HostFrame = {
	t: "welcome",
	proto: COLLAB_PROTO,
	header: HEADER,
	state: STATE,
	agents: [],
	entryCount: 0,
};

function renderResult(message: string, source = "deck-command:context", level: "info" | "warning" | "error" = "info"): string {
	const client = new GuestClient(LINK, "tester");
	client.applyFrameForTest(welcome, { flush: true });
	expectCommandResult(source.replace("deck-command:", ""));
	client.applyFrameForTest({
		t: "event",
		event: { type: "notice", level, message, source },
	}, { flush: true });
	return renderToStaticMarkup(<CommandResults client={client} sessionId="session-1" />);
}

describe("command result cards", () => {
	it("renders Markdown reports with GFM tables and keeps plain output monospace with ANSI removed", () => {
		const markdown = renderResult("## Changelog\n\n| Command | Result |\n| --- | --- |\n| /usage | meters |", "deck-command:changelog");
		expect(markdown).toContain("<h2>Changelog</h2>");
		expect(markdown).toContain("<table>");

		const plain = renderResult("ready\t\u001b[31mconnected\u001b[0m\nnext line");
		expect(plain).toContain("class=\"cr-plain\"");
		expect(plain).toContain("ready   connected");
		expect(plain).not.toContain("\u001b[31m");
	});

	it("maps sanitized usage reports to status-colored meters, remaining amounts, reset countdowns, and saved resets", () => {
		const now = Date.UTC(2026, 9, 24, 12, 0, 0);
		const clock = vi.spyOn(Date, "now").mockReturnValue(now);
		try {
			const payload =
				JSON.stringify({
					type: "deck-command-result",
					text: "Usage report text fallback",
					usageReports: [
						{
							provider: "openai-codex",
							fetchedAt: now,
							metadata: { email: "operator@example.com", endpoint: "must not display" },
							limits: [
								{
									id: "weekly",
									label: "Weekly",
									scope: { provider: "openai-codex", accountId: "acct-1", windowId: "7d" },
									window: { label: "7 Day", resetsAt: now + 2 * 60 * 60_000 + 14 * 60_000 - 1 },
									amount: { used: 80, limit: 100, remaining: 20, usedFraction: 0.8, unit: "requests" },
									status: "warning",
									notes: ["provider note"],
								},
								{ label: "Unreported", scope: { provider: "openai-codex" }, amount: { unit: "unknown" } },
								{
									id: "normal",
									label: "Normal",
									scope: { provider: "openai-codex", accountId: "acct-1", windowId: "daily" },
									amount: { used: 32, limit: 100, remaining: 68, usedFraction: 0.32, unit: "requests" },
								},
								{
									id: "exhausted",
									label: "Exhausted",
									scope: { provider: "openai-codex", accountId: "acct-1", windowId: "short" },
									amount: { used: 100, limit: 100, remaining: 0, usedFraction: 1, unit: "requests" },
								},
							],
							resetCredits: { availableCount: 2, redeemableCount: 1, eligible: true },
						},
					],
				}) ?? "";
			const html = renderResult(payload, "deck-command:usage");
			expect(html).toContain("operator@example.com");
			expect(html).toContain('data-status="warning"');
			expect(html).toContain('data-status="ok"');
			expect(html).toContain('data-status="exhausted"');
			expect(html).toContain('data-status="unknown"');
			expect(html).toContain("80% used · 80 requests of 100 requests");
			expect(html).toContain("20 requests left");
			expect(html).toContain("resets in 2h 14m");
			expect(html).toContain("2 saved rate-limit resets");
			expect(html).toContain("1 redeemable");
			expect(html).toContain("Usage data unavailable");
			expect(html).not.toContain("must not display");
		} finally {
			clock.mockRestore();
		}
	});

	it("offers expansion for long reports and marks command failures as alerts", () => {
		const longText = Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n");
		const html = renderResult(longText, "deck-command:changelog");
		expect(html).toContain('aria-label="Expand /changelog output"');

		const error = renderResult("Command refused", "deck-command:security", "error");
		expect(error).toContain('role="alert"');
		expect(error).toContain("/security");
	});
});
