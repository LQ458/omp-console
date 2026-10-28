import { describe, expect, it } from "bun:test";
import type { DaemonHealth, QuotaResponse, SessionStatsView, SessionSummary, UsageAccountView, UsageWindowView, WorkerHealth, Workspace } from "@omp-console/protocol";
import type { SessionHeader } from "@oh-my-pi/pi-wire";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_STATUS_SEGMENTS, HeaderBar, readStatusSegments, STATUS_SEGMENT_STORAGE_KEY, statusSegmentValues, writeStatusSegments, type StatusSegmentStorage } from "../src/components/shell/HeaderBar";
import { formatSettingsStatus, SettingsStatusView, summarizeNotificationStatus, summarizeSettingsStatus } from "../src/components/shell/SettingsSheet";
import { QuotaPanel } from "../src/components/quota/QuotaPanel";
import { quotaAdvice, quotaHealth } from "../src/lib/quota";
import { DeckApi } from "../src/lib/api";

function windowView(id: string, usedPct: number, reservePct = 15, projectedPct?: number): UsageWindowView {
	return {
		id,
		usedPct,
		reservePct,
		resetsAt: Date.now() + 3_600_000,
		...(projectedPct === undefined ? {} : { projectedPct }),
	};
}

function account(windows: UsageWindowView[], stale = false): UsageAccountView {
	return { provider: "OpenRouter", account: "team-a", windows, fetchedAt: Date.now(), stale };
}

function quotaResponse(usedPct = 65, projectedPct = 74, stale = false, flowState: "ok" | "throttled" | "paused" | "rate-limited" | "unknown" = "throttled"): QuotaResponse {
	return {
		accounts: [account([windowView("5h", usedPct, 15, projectedPct), windowView("7d", 20, 10)], stale)],
		providers: [{
			provider: "OpenRouter",
			headroomPct: 20,
			bindingWindow: "5h",
			cap: 3,
			running: 1,
			queued: 2,
			state: flowState,
			burnLocalPctPerMin: 1.25,
			burnExternalPctPerMin: 0.5,
			reason: "provider pacing",
			resumesAt: Date.now() + 600_000,
		}],
		equivalence: { tiers: [
			{ tier: "default", roles: ["default"], models: ["openai/gpt-luna"] },
			{ tier: "judgment", roles: ["judge"], models: [] },
		] },
		cacheWarming: "streaming",
		updatedAt: Date.now(),
	};
}

function worker(sessionId: string, state: WorkerHealth["state"]): WorkerHealth {
	return { sessionId, pid: 1, state, rssBytes: 1024, startedAt: 1, lastEventAt: 2, stalled: false, restarts: 0 };
}

const health: DaemonHealth = {
	version: 1,
	startedAt: 1,
	workers: [worker("streaming", "streaming"), worker("idle", "idle"), worker("crashed", "crashed")],
	guests: 0,
	stalledAfterMs: 60_000,
};

describe("quota summary", () => {
	it("advises large tasks only when the limiting window has room beyond its reserve", () => {
		expect(quotaAdvice([account([windowView("5h", 50), windowView("7d", 30, 10)])])).toBe("Large tasks can run now.");
		expect(quotaAdvice([account([windowView("5h", 70)])])).toBe("Near the reserve: omp console will switch to Luna at 85%.");
		expect(quotaAdvice([account([windowView("5h", 85)])])).toBe("At the reserve: omp console will switch to Luna at 85%.");
	});

	it("uses the forecast when it crosses the reserve and does not encourage work on stale or missing data", () => {
		expect(quotaAdvice([account([windowView("5h", 60, 15, 86)])])).toBe("At the reserve: omp console will switch to Luna at 85%.");
		expect(quotaAdvice([account([windowView("5h", 60)], true)])).toBe("Quota data is stale; refresh before starting a large task.");
		expect(quotaAdvice([account([])])).toBe("Quota window data is unavailable.");
	});

	it("classifies quota health for the settings summary from window and flow-control states", () => {
		expect(quotaHealth(quotaResponse())).toBe("near-reserve");
		expect(quotaHealth(quotaResponse(20, 25, false, "ok"))).toBe("healthy");
		expect(quotaHealth(quotaResponse(70, 86, false, "ok"))).toBe("at-reserve");
		expect(quotaHealth(quotaResponse(20, 25, false, "paused"))).toBe("limited");
		expect(quotaHealth(quotaResponse(20, 25, true, "ok"))).toBe("stale");
		expect(quotaHealth(null)).toBe("unknown");
	});

	it("keeps the complete account, flow, equivalence, and cache controls under a closed Details disclosure", () => {
		const html = renderToStaticMarkup(<QuotaPanel api={new DeckApi()} initial={quotaResponse()} />);
		const details = html.match(/<details class="q-details">([\s\S]*?)<\/details>/)?.[1];
		expect(details).toBeDefined();
		expect(html).not.toContain('<details class="q-details" open');
		expect((html.match(/role="progressbar"/g) ?? []).length).toBe(1);
		expect(html).toContain('aria-label="OpenRouter team-a 5h usage"');
		const overview = html.split('<details class="q-details">')[0] ?? html;
		expect(overview).toMatch(/aria-valuetext="65% used; resets \d+h \d+m"/);
		expect(overview).toContain('class="q-account-summary-percent">65%');
		expect(details).toContain("Accounts and windows");
		expect(details).toContain("projected 74% at reset");
		expect(details).toContain("15% headroom reserve");
		expect(details).toContain("Flow control");
		expect(details).toContain("provider pacing");
		expect(details).toContain("running");
		expect(details).toContain("queued");
		expect(details).toContain("Equivalence table");
		expect(details).toContain("openai/gpt-luna");
		expect(details).toContain("Cache warming");
		expect(details).toContain('aria-checked="true"');
	});

	it("marks every account stale with its last update time once the snapshot stopped refreshing", () => {
		const fresh = renderToStaticMarkup(<QuotaPanel api={new DeckApi()} initial={quotaResponse()} />);
		expect(fresh).not.toContain("last updated");
		expect(fresh).not.toContain('data-stale="true"');
		const old = renderToStaticMarkup(<QuotaPanel api={new DeckApi()} initial={{ ...quotaResponse(), updatedAt: Date.now() - 3 * 60_000 }} />);
		expect(old).toContain("last updated");
		expect(old).toContain('data-stale="true"');
	});
});

describe("settings status summary", () => {
	it("shows running sessions, notification state, quota health, and the active decision backend", () => {
		const summary = summarizeSettingsStatus(health, "on", quotaResponse(), "jev");
		expect(summary.runningSessions).toBe(2);
		const html = renderToStaticMarkup(<SettingsStatusView summary={summary} />);
		expect(html).toContain("2 sessions running · Notifications on · Quota near reserve · Decision backend Jev");
		expect(formatSettingsStatus({ ...summary, runningSessions: 1, notifications: "managed", decisionBackend: "luna" }))
			.toBe("1 session running · Notifications managed by macOS · Quota near reserve · Decision backend Luna");
	});
	it("distinguishes unsupported, blocked, and install-required notifications from off", () => {
		expect(summarizeNotificationStatus("enabled")).toBe("on");
		expect(summarizeNotificationStatus("off")).toBe("off");
		expect(summarizeNotificationStatus("denied")).toBe("blocked");
		expect(summarizeNotificationStatus("install-required")).toBe("install-required");
		expect(summarizeNotificationStatus("unsupported")).toBe("unavailable");
	});

});

const sessionHeader: SessionHeader = {
	type: "session",
	id: "session-1",
	title: "Build panels",
	timestamp: "2020-01-01T00:00:00.000Z",
	cwd: "/workspace/panels",
};

const workspace: Workspace = {
	id: "project:panels",
	kind: "project",
	name: "panels",
	root: "/workspace/panels",
	rules: [],
	git: { branch: "feat/panels", dirty: true },
	liveSessions: 1,
};

const stats: SessionStatsView = {
	tokens: { input: 100, output: 20, cacheRead: 100, cacheWrite: 10, reasoning: 4 },
	cost: 0.1234,
	contextTokens: 100,
	contextWindow: 1000,
	byAgent: [{ agentId: "main", tokens: 230, cost: 0.1234 }],
};

describe("header status segments", () => {
	it("formats branch, statistics, cache hit, elapsed time, and subagent count from omp console data", () => {
		const values = statusSegmentValues(workspace, sessionHeader, stats, 2, Date.parse(sessionHeader.timestamp) + 65_000);
		expect(values).toEqual({
			branch: "feat/panels",
			tokens: "230 tok",
			cost: "$0.123",
			cache: "50%",
			elapsed: "1m05s",
			subagents: "2",
		});
		expect(statusSegmentValues(workspace, { ...sessionHeader, timestamp: "invalid" }, null, 0, 1).elapsed).toBeNull();
	});

	it("persists a canonical selection locally and ignores unknown saved segments", () => {
		const values = new Map<string, string>();
		const storage: StatusSegmentStorage = {
			getItem: key => values.get(key) ?? null,
			setItem: (key, value) => { values.set(key, value); },
		};
		expect(readStatusSegments(storage)).toEqual(DEFAULT_STATUS_SEGMENTS);
		writeStatusSegments(storage, ["cost", "branch"]);
		expect(storage.getItem(STATUS_SEGMENT_STORAGE_KEY)).toBe('["branch","cost"]');
		expect(readStatusSegments(storage)).toEqual(["branch", "cost"]);
		storage.setItem(STATUS_SEGMENT_STORAGE_KEY, '["cache","future","cache"]');
		expect(readStatusSegments(storage)).toEqual(["cache"]);
		writeStatusSegments(storage, []);
		expect(readStatusSegments(storage)).toEqual([]);
	});

	it("renders the chooser and current readouts in the header", () => {
		const html = renderToStaticMarkup(
			<HeaderBar
				mode="desktop"
				header={sessionHeader}
				state={null}
				phase="live"
				readOnly={false}
				subCount={2}
				railOpen={false}
				onToggleRail={() => {}}
				onLeave={() => {}}
			/>,
		);
		expect(html).toContain('aria-label="choose status bar segments"');
		// No optional status readouts appear by default; each can be enabled in the chooser.
		expect(html).not.toContain('data-status-segment="branch"');
		expect(html).not.toContain('data-status-segment="tokens"');
		expect(html).not.toContain('data-status-segment="cost"');
		expect(html).not.toContain('data-status-segment="cache"');
		expect(html).not.toContain('data-status-segment="elapsed"');
		expect(html).not.toContain('data-status-segment="subagents"');
	});
	it("hides Overnight run status from the header until the feature is enabled", () => {
		const summary: SessionSummary = {
			id: "session-1",
			cwd: "/workspace/panels",
			state: "idle",
			createdAt: 1,
			lastActivityAt: 2,
			agentCount: 1,
			goalActive: false,
			awaitingAnswer: false,
			overnight: { phase: "complete", deadline: "2025-01-01T00:00:00.000Z", continuations: 1 },
		};
		const render = (overnightEnabled: boolean): string => renderToStaticMarkup(
			<HeaderBar
				mode="phone"
				header={sessionHeader}
				sessionSummary={summary}
				state={null}
				phase="live"
				readOnly={false}
				subCount={0}
				railOpen={false}
				onToggleRail={() => {}}
				onLeave={() => {}}
				overnightEnabled={overnightEnabled}
			/>,
		);
		const disabled = render(false);
		expect(disabled).not.toContain("Overnight run");
		const enabled = render(true);
		expect(enabled).toContain('class="sh-chip dk-overnight-chip"');
		expect(enabled).toContain("Overnight run");
	});

	it("shows a distinct paused state and resume action without model controls", () => {
		const now = Date.now();
		const pausedSession: SessionSummary = {
			id: "paused-session",
			cwd: "/repo",
			state: "idle",
			createdAt: now - 60_000,
			lastActivityAt: now,
			agentCount: 1,
			goalActive: false,
			awaitingAnswer: false,
			paused: true,
			pausedAt: now - 60_000,
		};
		const html = renderToStaticMarkup(
			<HeaderBar
				mode="desktop"
				header={sessionHeader}
				state={null}
				sessionSummary={pausedSession}
				phase="live"
				readOnly={false}
				subCount={0}
				railOpen={false}
				onToggleRail={() => {}}
				onLeave={() => {}}
				onTogglePause={() => {}}
			/>,
		);
		expect(html).toContain("sh-paused-chip");
		expect(html).toContain('aria-label="resume session"');
	});
});
