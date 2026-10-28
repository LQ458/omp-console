import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionSummary } from "@omp-console/protocol";
import { createReportRoutes } from "../src/report/routes";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-console-report-test-"));
	roots.push(root);
	return root;
}

describe("improvement report route", () => {
	it("returns the accepted job before the report worker is ready", async () => {
		const root = tempDir();
		const stateDir = path.join(root, "state");
		const workRoot = path.join(root, "work");
		fs.mkdirSync(stateDir, { recursive: true });
		fs.mkdirSync(workRoot, { recursive: true });
		fs.writeFileSync(path.join(stateDir, "journal.jsonl"), "{\"feature\":\"report\"}\n");

		const createStarted = Promise.withResolvers<void>();
		const releaseCreate = Promise.withResolvers<SessionSummary>();
		const routes = createReportRoutes({
			async createSession(request) {
				createStarted.resolve();
				return releaseCreate.promise.then(session => ({ ...session, cwd: request.cwd }));
			},
		}, stateDir, { workRoot });
		const request = new Request("http://deck.test/api/report", { method: "POST" });
		const routePromise = routes(request, new URL(request.url));
		let response: Response | undefined;
		try {
			await createStarted.promise;
			response = await Promise.race([routePromise, Bun.sleep(50).then(() => undefined)]);
		} finally {
			releaseCreate.resolve({
				id: "report-session",
				cwd: workRoot,
				state: "starting",
				createdAt: 1,
				lastActivityAt: 1,
				agentCount: 0,
				goalActive: false,
				awaitingAnswer: false,
			});
			await routePromise;
		}
		const runFile = path.join(stateDir, "report-run.json");
		for (let attempt = 0; attempt < 100 && !fs.existsSync(runFile); attempt++) await Bun.sleep(5);
		expect(fs.existsSync(runFile)).toBe(true);

		expect(response?.status).toBe(202);
		const job = await response!.json() as { jobId: string; status: string };
		expect(job.jobId).toMatch(/^[0-9a-f-]{36}$/);
		expect(job.status).toBe("starting");
	});
});
