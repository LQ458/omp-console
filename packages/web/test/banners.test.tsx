import { afterEach, describe, expect, it, vi } from "bun:test";
import type { RestartNotice } from "../src/lib/api";
import { RESTART_LOST_MESSAGE } from "../src/lib/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
	OfflineBanner,
	PaneRecoveryBanner,
	RESTART_NOTICE_TTL_MS,
	Banners,
	RestartNoticeBanner,
	scheduleRestartNoticeDismiss,
} from "../src/components/shell/Banners";

afterEach(() => vi.useRealTimers());

describe("restart notice banner", () => {
	it("shows resumed sessions, interrupted work, and a dismiss action", () => {
		const notice: RestartNotice = { at: 1_800_000_000_000, resumed: 1, interruptedTitles: ["Deep task"] };
		const html = renderToStaticMarkup(<RestartNoticeBanner notice={notice} onDismiss={() => {}} />);

		expect(html).toContain(new Date(notice.at).toLocaleString());
		expect(html).toContain("1 session resumed");
		expect(html).toContain("turn interrupted in: Deep task");
		expect(html).toContain('aria-label="Dismiss restart notice"');
	});
	it("dismisses after 30 seconds and cancels the timer when removed", () => {
		vi.useFakeTimers();
		const dismiss = vi.fn();
		const cancel = scheduleRestartNoticeDismiss(dismiss);

		vi.advanceTimersByTime(RESTART_NOTICE_TTL_MS - 1);
		expect(dismiss).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(dismiss).toHaveBeenCalledTimes(1);

		const removed = vi.fn();
		scheduleRestartNoticeDismiss(removed)();
		vi.advanceTimersByTime(RESTART_NOTICE_TTL_MS);
		expect(removed).not.toHaveBeenCalled();
		cancel();
	});
});
describe("connection recovery", () => {
	it("offers a same-prompt restart without implying it was sent", () => {
		const html = renderToStaticMarkup(
			<Banners
				phase="reconnecting"
				endedReason={RESTART_LOST_MESSAGE}
				loading={null}
				onRejoin={() => {}}
				onNewLink={() => {}}
			/>,
		);

		expect(html).toContain(RESTART_LOST_MESSAGE);
		expect(html).toContain(">Start again with the same prompt (not sent yet)</button>");
		expect(html).not.toMatch(/<button[^>]*disabled=/);
		expect(html).not.toContain("Reconnecting…");
	});
	it("tells the user that offline messages are retained", () => {
		const html = renderToStaticMarkup(<OfflineBanner />);

		expect(html).toContain("Offline — messages are kept, not sent");
	});

	it("distinguishes reconnecting from stopped sessions and exposes Resume", () => {
		const reconnecting = renderToStaticMarkup(<PaneRecoveryBanner status="reconnecting" />);
		const stopped = renderToStaticMarkup(<PaneRecoveryBanner status="stopped" onResume={() => {}} />);

		expect(reconnecting).toContain("Reconnecting to omp console…");
		expect(stopped).toContain("Session stopped");
		expect(stopped).toContain(">Resume</button>");
	});

	it("retains and identifies a session while its peer is unreachable", () => {
		const html = renderToStaticMarkup(<PaneRecoveryBanner status={null} machineName="Studio Mac" />);

		expect(html).toContain("Studio Mac is unreachable — showing the last state; it reconnects when the machine is back");
	});
});
