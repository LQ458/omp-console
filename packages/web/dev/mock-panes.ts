/**
 * Mock support for the tiled panes (grand-list 10) and queue chips (spec 1.2). Registered from `mock-daemon.ts`
 * by `paneFixtures` (extra live sessions, `--panes`) and one call to `handlePanesMock` (the dequeue op).
 *
 * Simulated, not real:
 * - `--panes` adds six live sessions, `pane-1` .. `pane-6`, each streaming 100 tokens/s (20 s per message,
 *   repeating) over a short transcript: the "six panes streaming" bench and the pane screenshots.
 * - `POST /api/sessions/:id/ops` answers `{ op: "dequeue", index }` with `{ ok: true }` and records it; every
 *   other op returns undefined (another area's mock may answer it). The mock room's queue count is not
 *   decremented (the room has no dequeue), so after a removal the count and the chips come back; the recorded call
 *   (`GET /api/mock/panes/ops`) is what proves the web sent the right index.
 */
import type { ApiError, SessionOp, SessionOpResult } from "@omp-console/protocol";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { makeTranscript } from "../bench/make-transcript";
import type { MockRoomOptions } from "./mock-room";

export const PANE_SESSION_COUNT = 6;
export const PANE_SESSION_IDS: readonly string[] = Array.from({ length: PANE_SESSION_COUNT }, (_, i) => `pane-${i + 1}`);

const TITLES = [
	"Refactor relay backoff",
	"Docs sweep",
	"Landing page copy",
	"Rate limiter spike",
	"Collab reconnect investigation",
	"Flaky test triage",
];
const CWDS = ["/Users/dev/relay", "/Users/dev/docs", "/Users/dev/site", "/Users/dev/api", "/Users/dev/relay", "/Users/dev/ci"];

export interface PaneFixture {
	id: string;
	title: string;
	cwd: string;
	fixture: Pick<MockRoomOptions, "entries" | "stream">;
}

/** The six streaming sessions `--panes` starts. Each has its own short transcript so the panes look different. */
export function paneFixtures(): PaneFixture[] {
	return PANE_SESSION_IDS.map((id, i) => {
		const entries: SessionEntry[] = makeTranscript({ lines: 400 + i * 60, seed: i + 1 });
		return {
			id,
			title: `${TITLES[i] ?? id} (pane ${i + 1})`,
			cwd: CWDS[i] ?? "/Users/dev/panes",
			fixture: { entries, stream: { tokensPerSecond: 100, durationMs: 20_000 } },
		};
	});
}

export interface RecordedOp {
	sessionId: string;
	op: SessionOp;
}

const recorded: RecordedOp[] = [];

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fail(status: number, code: ApiError["code"], error: string): Response {
	const body: ApiError = { error, code };
	return json(body, status);
}

/** `route` is the path after `/api`. */
export async function handlePanesMock(
	req: Request,
	route: string,
	ctx: { hasSession(id: string): boolean },
): Promise<Response | undefined> {
	if (route === "/mock/panes/ops" && req.method === "GET") return json(recorded);
	const match = /^\/sessions\/([^/]+)\/ops$/.exec(route);
	if (!match || req.method !== "POST") return undefined;
	const sessionId = decodeURIComponent(match[1]!);
	const body = (await req.clone().json().catch(() => null)) as SessionOp | null;
	if (body === null || body.op !== "dequeue") return undefined;
	if (!ctx.hasSession(sessionId)) return fail(404, "not-found", "no such live session");
	recorded.push({ sessionId, op: body });
	const result: SessionOpResult = { ok: true };
	return json(result);
}
