import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type { Notice } from "../src/lib/client";
import { runToastAction, shouldShowToast, toastAutoDismissMs, Toasts, type ToastAction } from "../src/components/shell/Toasts";

describe("visible toast notices", () => {
	test("suppresses collaboration churn and MCP mount chatter", () => {
		expect(shouldShowToast("deck joined the collab session")).toBe(false);
		expect(shouldShowToast("Ada left the collab session (read-only)")).toBe(false);
		expect(shouldShowToast("xd://: mounted mcp__siyuan_local_siyuan_append_block")).toBe(false);
	});

	test("keeps user-actionable host notices", () => {
		expect(shouldShowToast("context compacted")).toBe(true);
		expect(shouldShowToast("rate limited, retrying in 20s")).toBe(true);
	});
	test("keeps only short one-line command confirmations in transient toasts", () => {
		expect(shouldShowToast("Current model: gpt-6-luna", "deck-command:model", "info")).toBe(true);
		expect(shouldShowToast("Context report\nNext line", "deck-command:context", "info")).toBe(false);
		expect(shouldShowToast("Usage", "deck-command:usage", "info")).toBe(false);
		expect(shouldShowToast("Command refused", "deck-command:security", "error")).toBe(false);
	});
});

function notice(id: number, level: Notice["level"], message: string, at: number): Notice {
	return { id, level, message, at };
}

describe("toast surface behavior", () => {
	test("keeps at most three notices and preserves the newest actionable result beside errors", () => {
		const html = renderToStaticMarkup(createElement(Toasts, {
			notices: [
				notice(1, "info", "older confirmation", 1),
				notice(2, "warning", "warning", 2),
				notice(3, "error", "connection failed", 3),
				notice(4, "info", "latest confirmation", 4),
			],
		}));

		expect(html.match(/class="sh-toast /g)).toHaveLength(3);
		expect(html).not.toContain("older confirmation");
		expect(html).toContain("warning");
		expect(html).toContain("latest confirmation");
		expect(html).toContain('role="alert"');
		expect(html).toContain('aria-label="Dismiss error notice"');
	});

	test("auto-dismisses non-errors after four seconds and leaves errors persistent", () => {
		expect(toastAutoDismissMs("info")).toBe(4000);
		expect(toastAutoDismissMs("warning")).toBe(4000);
		expect(toastAutoDismissMs("error")).toBeNull();
	});

	test("renders and runs an undo action, then closes even if the action throws", () => {
		let draft = "starter prompt";
		let closed = false;
		const undo: ToastAction = { label: "Undo", onAction: () => { draft = ""; } };
		const html = renderToStaticMarkup(createElement(Toasts, {
			notices: [notice(5, "info", "Starter prompt added.", 5)],
			actions: new Map([[5, undo]]),
		}));

		expect(html).toContain(">Undo</button>");
		runToastAction(undo, () => { closed = true; });
		expect(draft).toBe("");
		expect(closed).toBe(true);

		closed = false;
		expect(() => runToastAction({ label: "Retry", onAction: () => { throw new Error("failed"); } }, () => { closed = true; })).toThrow("failed");
		expect(closed).toBe(true);
	});
});
