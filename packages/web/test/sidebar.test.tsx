import { describe, expect, it } from "bun:test";
import type { DaemonHealth, SessionSummary } from "@omp-console/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionSidebar, sleepCandidateAndContinue, type SessionSidebarProps } from "../src/components/switcher/SessionSidebar";
import { DeckApiError } from "../src/lib/api";

function session(id: string, extra: Partial<SessionSummary> = {}): SessionSummary {
	return {
		id,
		title: `title-${id}`,
		cwd: `/work/${id}`,
		sessionFile: `/work/${id}.jsonl`,
		state: "idle",
		createdAt: 1,
		lastActivityAt: Date.now(),
		agentCount: 0,
		goalActive: false,
		awaitingAnswer: false,
		...extra,
	};
}

const noop = (): void => {};

function render(overrides: Partial<SessionSidebarProps>): string {
	return renderToStaticMarkup(
		<SessionSidebar
			sessions={null}
			health={null}
			listError={null}
			authFailed={false}
			selectedId={null}
			busy={false}
			actionError={null}
			onSelect={noop}
			onResume={noop}
			onFork={noop}
			onStop={noop}
			onCreate={noop}
			{...overrides}
		/>,
	);
}

describe("SessionSidebar", () => {
	it("shows each live session's state, markers, agent count and model, and the selected one", () => {
		const health: DaemonHealth = {
			version: 1,
			startedAt: 1,
			guests: 0,
			stalledAfterMs: 60_000,
			workers: [
				{
					sessionId: "c",
					pid: 1,
					state: "streaming",
					rssBytes: 1,
					startedAt: 1,
					lastEventAt: 1,
					stalled: true,
					restarts: 0,
				},
			],
		};
		const html = render({
			sessions: {
				live: [
					session("a", { state: "streaming", agentCount: 3, model: "opus-x", goalActive: true }),
					session("b", { state: "asking", awaitingAnswer: true }),
					session("c", { state: "streaming" }),
				],
				recent: [session("old", { state: "stopped" })],
			},
			health,
			selectedId: "b",
		});
		// Every state badge class appears for its row.
		expect(html).toContain("dk-state-streaming");
		expect(html).toContain("dk-state-asking");
		expect(html).toContain("dk-state-stopped");
		expect(html).toContain("opus-x");
		expect(html).toContain("3 subagents");
		expect(html).toContain("goal active");
		expect(html).toContain('class="dk-card-status dk-card-status-waiting"');
		expect(html).toContain(">Waiting</span>");
		expect(html).toContain("stalled: no events while streaming");
		// Only the selected row is marked current.
		expect(html.match(/aria-current="true"/g)).toHaveLength(1);
		expect(html).toContain("title-old");
	});
	it("keeps archived sessions out of active cards and starts the Archived group collapsed", () => {
		const archived = session("hidden-from-recent", {
			title: "Previously archived",
			state: "stopped",
			archivedAt: Date.now() - 3 * 24 * 60 * 60 * 1000,
		});
		const html = render({
			sessions: { live: [], recent: [archived], archived: [archived] },
		});
		expect(html).toContain("Archived (1)");
		expect(html).toContain('class="dk-section dk-section-button dk-archive-section" aria-expanded="false"');
		expect(html).not.toContain("Previously archived");
	});

	it("distinguishes an unreachable daemon from a refused one", () => {
		const outage = render({ listError: new DeckApiError("network", 0, "daemon unreachable") });
		const refused = render({ listError: new DeckApiError("auth", 401, "x"), authFailed: true });
		expect(outage).toContain("omp console is restarting / unreachable");
		expect(outage).not.toContain("Not authorized");
		expect(refused).toContain("Not authorized");
		expect(refused).not.toContain("Daemon unreachable");
	});
	it("keeps the last-known sessions greyed during a local daemon outage", () => {
		const outage = render({
			sessions: { live: [session("last-known")], recent: [session("last-recent", { state: "stopped" })] },
			listError: new DeckApiError("network", 0, "daemon unreachable"),
		});
		expect(outage).toContain("omp console is restarting / unreachable — showing the last known sessions");
		expect(outage).toContain('data-local-outage="true"');
		expect(outage).toContain("title-last-known");
		expect(outage).not.toContain("VPS unreachable");
		expect(outage).not.toContain("No sessions.");

		const empty = render({
			sessions: null,
			listError: new DeckApiError("network", 0, "daemon unreachable"),
		});
		expect(empty).not.toContain("No sessions.");
		expect(empty).toContain("No last-known session list is available yet.");
	});

	it("shows the first-session action and surfaces the persisted-session scan directory", () => {
		const empty = render({ sessions: { live: [], recent: [] } });
		expect(empty).toContain("No sessions yet. Start one with + or pick a project folder.");

		const directory = "/tmp/omp-console-sessions";
		const failed = render({
			sessions: null,
			listError: new DeckApiError("server", 500, `Could not scan omp sessions in ${directory}: permission denied`),
		});
		expect(failed).toContain(directory);
		expect(failed).toContain("Saved sessions could not be loaded. See the error above for the directory and next step.");
	});
	it("shows the worker-limit action with the daemon's chosen session title", () => {
		const html = render({
			actionError: "worker limit reached",
			sleepCandidateRetry: {
				candidate: { id: "idle-1", title: "Oldest idle session", idleMinutes: 12 },
				request: { cwd: "/work/new", createDirectory: true },
				machineId: "vps",
			},
		});

		expect(html).toContain("Sleep");
		expect(html).toContain("Oldest idle session");
		expect(html).toContain("and continue");
	});

	it("sleeps the offered session before retrying the exact request on its machine", async () => {
		const events: unknown[] = [];
		const retry = {
			candidate: { id: "idle-1", title: "Oldest idle session", idleMinutes: 12 },
			request: { cwd: "/work/new", createDirectory: true },
			machineId: "vps",
		};
		await sleepCandidateAndContinue(
			{
				async sleepSession(id) {
					events.push({ sleep: id });
					return { state: "asleep" };
				},
			},
			retry,
			(request, machineId) => events.push({ request, machineId }),
		);

		expect(events).toEqual([
			{ sleep: "idle-1" },
			{ request: retry.request, machineId: "vps" },
		]);
	});

	it("does not retry a worker-limit create when sleeping its candidate fails", async () => {
		const retry = {
			candidate: { id: "idle-1", title: "Oldest idle session", idleMinutes: 12 },
			request: { cwd: "/work/new" },
		};
		let retried = false;
		await expect(
			sleepCandidateAndContinue(
				{ sleepSession: async () => Promise.reject(new Error("session became busy")) },
				retry,
				() => {
					retried = true;
				},
			),
		).rejects.toThrow("session became busy");
		expect(retried).toBe(false);
	});


	it("keeps row actions in overflow instead of inline beside the open target", () => {
		const html = render({
			sessions: { live: [session("saved"), session("unsaved", { sessionFile: undefined })], recent: [] },
		});
		expect(html).toContain('aria-label="Actions for title-saved"');
		expect(html).toContain('aria-label="Actions for title-unsaved"');
		expect(html).not.toContain('aria-label="fork ');
	});
	it("hides quick ask until its capability is enabled", () => {
		const disabled = render({ sessions: { live: [], recent: [] } });
		const enabled = render({ sessions: { live: [], recent: [] }, quickAskEnabled: true });
		expect(disabled).not.toContain('aria-label="Ask your notes"');
		expect(enabled).toContain('aria-label="Ask your notes"');
	});
});
