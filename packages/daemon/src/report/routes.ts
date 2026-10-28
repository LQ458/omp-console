/**
 * Improvement report (spec 0.7): `POST /api/report` copies omp console's own logs (journal, feedback, plan runs; never
 * transcripts, push keys or subscriptions) into a fresh directory outside the state dir and starts a hidden session
 * there whose first prompt asks for `report.md`. `GET /api/report` returns the newest finished report or `null`.
 */
import * as fs from "node:fs/promises";
import { logger } from "@oh-my-pi/pi-utils";
import * as os from "node:os";
import * as path from "node:path";
import type { CreateSessionRequest, ImprovementReport, SessionSummary } from "@omp-console/protocol";
import { errorResponse } from "../api";
import promptText from "./prompt.md" with { type: "text" };

const REPORT_ROUTE = "/api/report";
const INPUTS = ["journal.jsonl", "feedback.jsonl", "plan-runs.jsonl"] as const;

export interface ReportPorts {
	createSession(request: CreateSessionRequest): Promise<SessionSummary>;
}

export interface ReportRouteOptions {
	/** Parent of the per-run work directories; default the OS temp dir. */
	workRoot?: string;
	now?: () => number;
}

interface LastRun {
	dir: string;
	sessionId: string;
	startedAt: number;
}

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function createReportRoutes(
	ports: ReportPorts,
	stateDir: string,
	options: ReportRouteOptions = {},
): (req: Request, url: URL) => Promise<Response | undefined> {
	const now = options.now ?? Date.now;
	const lastFile = path.join(stateDir, "report-run.json");
	const reportFile = path.join(stateDir, "report.md");

	async function readLast(): Promise<LastRun | undefined> {
		try {
			const value = JSON.parse(await fs.readFile(lastFile, "utf8")) as Partial<LastRun>;
			if (typeof value.dir === "string" && typeof value.sessionId === "string" && typeof value.startedAt === "number") {
				return { dir: value.dir, sessionId: value.sessionId, startedAt: value.startedAt };
			}
		} catch {}
		return undefined;
	}

	/** Copies a finished `report.md` of the last run into the state dir, then answers from the state dir copy. */
	async function latest(): Promise<ImprovementReport | null> {
		const last = await readLast();
		if (last) {
			const produced = path.join(last.dir, "report.md");
			try {
				const stat = await fs.lstat(produced);
				if (stat.isFile() && stat.size <= 1024 * 1024) {
					await fs.writeFile(reportFile, await fs.readFile(produced, "utf8"), { mode: 0o600 });
				}
			} catch {}
		}
		try {
			const [markdown, stat] = await Promise.all([fs.readFile(reportFile, "utf8"), fs.stat(reportFile)]);
			return { generatedAt: stat.mtimeMs, markdown, path: reportFile };
		} catch {
			return null;
		}
	}

	async function start(): Promise<{ jobId: string; status: "starting" }> {
		// Keep the last finished report in the state dir, then drop the previous run's copies of the logs.
		await latest();
		const previous = await readLast();
		if (previous && path.basename(previous.dir).startsWith("omp-console-report-")) await fs.rm(previous.dir, { recursive: true, force: true });
		const root = options.workRoot ?? os.tmpdir();
		const dir = await fs.mkdtemp(path.join(root, "omp-console-report-"));
		for (const name of INPUTS) {
			try {
				await fs.copyFile(path.join(stateDir, name), path.join(dir, name));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		const jobId = crypto.randomUUID();
		const startedAt = now();
		void (async () => {
			let sessionCreated = false;
			try {
				const session = await ports.createSession({ cwd: dir, title: "improvement report", hidden: true, handoff: promptText });
				sessionCreated = true;
				const run: LastRun = { dir, sessionId: session.id, startedAt };
				await fs.writeFile(lastFile, JSON.stringify(run), { mode: 0o600 });
			} catch (error) {
				if (!sessionCreated) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
				logger.error("improvement report job failed", {
					jobId,
					errorName: error instanceof Error ? error.name : "unknown error",
				});
			}
		})();
		return { jobId, status: "starting" };
	}

	return async (req, url) => {
		if (url.pathname !== REPORT_ROUTE) return undefined;
		if (req.method === "GET") return json(200, await latest());
		if (req.method === "POST") return json(202, await start());
		return errorResponse(405, "bad-request", `method ${req.method} not allowed`, { Allow: "GET, POST" });
	};
}
