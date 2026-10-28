import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createSetupRoute } from "../src/setup/routes";
import { makeTmp } from "./helpers";

function makeRoute(agentDir: string, listRecent: () => Promise<never[]>, sessionsDir = agentDir) {
	return createSetupRoute({
		sessionsDir,
		agentDir,
		envKeys: ["PROVIDER_API_KEY"],
		listRecent,
		modelControl: {
			async availableModelCount() {
				return 0;
			},
			async modelRoles() {
				return { default: "anthropic/claude-sonnet" };
			},
		},
		async findOmp() {
			return { found: true, path: "/usr/local/bin/omp", version: "18.12.6", error: null };
		},
		async countMcpServers() {
			return 2;
		},
	});
}

async function getSetup(route: ReturnType<typeof createSetupRoute>): Promise<Response> {
	const request = new Request("http://127.0.0.1/api/setup");
	const response = await route(request, new URL(request.url));
	if (response === undefined) throw new Error("setup route did not match");
	return response;
}

describe("first-run setup API", () => {
	it("returns install, model, session, and agent configuration checks", async () => {
		const agentDir = makeTmp("omp-console-setup-");
		await fs.mkdir(path.join(agentDir, "skills"), { recursive: true });
		await fs.mkdir(path.join(agentDir, "extensions"), { recursive: true });
		await fs.writeFile(path.join(agentDir, "skills", "notes.md"), "skill");
		await fs.writeFile(path.join(agentDir, "extensions", "summaries.ts"), "export {};");
		const route = makeRoute(agentDir, async () => []);

		const response = await getSetup(route);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			omp: { found: true, path: "/usr/local/bin/omp", version: "18.12.6", error: null },
			models: { availableCount: 0, defaultModel: "anthropic/claude-sonnet", error: null },
			sessions: { agentDir, count: 0, error: null },
			ompSetup: {
				agentDir,
				defaultAgentDir: path.join(os.homedir(), ".omp", "agent"),
				usesDefaultAgentDir: false,
				defaultModel: "anthropic/claude-sonnet",
				modelRoles: 1,
				skills: 1,
				extensions: 1,
				mcpServers: 2,
				error: null,
			},
			envKeys: ["PROVIDER_API_KEY"],
		});
	});

	it("reports session scanning failures instead of returning an empty success", async () => {
		const agentDir = makeTmp("omp-console-setup-error-");
		const route = makeRoute(agentDir, async () => {
			throw new Error("session store permission denied");
		});
		const response = await getSetup(route);
		const body = await response.json() as { sessions: { agentDir: string; count: number | null; error: string | null }; models: { availableCount: number | null } };
		expect(body.sessions).toEqual({
			agentDir,
			count: null,
			error: "session store permission denied",
		});
		expect(body.models.availableCount).toBe(0);
	});
	it("surfaces a non-directory session-store error instead of counting zero", async () => {
		const agentDir = makeTmp("omp-console-setup-invalid-session-store-");
		const sessionsDir = path.join(agentDir, "not-a-directory");
		await fs.writeFile(sessionsDir, "not a directory");
		const response = await getSetup(makeRoute(agentDir, async () => [], sessionsDir));
		const body = await response.json() as { sessions: { count: number | null; error: string | null } };
		expect(body.sessions.count).toBeNull();
		expect(body.sessions.error).toMatch(/ENOTDIR|not a directory/i);
	});
});
