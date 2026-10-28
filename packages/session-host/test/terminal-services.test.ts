import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as cleanseModule from "@oh-my-pi/pi-coding-agent/cleanse/index";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { CleanseCommandResult } from "@oh-my-pi/pi-coding-agent/cleanse/types";
import { CleanseWorkerService } from "../src/cleanse";
import { OmfgWorkerService } from "../src/omfg";

const generatedRule = JSON.stringify({
	name: "cwd-rule",
	description: "Match the earlier response",
	condition: "echo:dynamic-cwd-marker",
	scope: "text",
	body: "Keep the response grounded in context.",
});

afterEach(() => vi.restoreAllMocks());

describe("terminal command worker cwd", () => {
	test("OMFG saves under the session cwd current at acceptance", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "deck-omfg-cwd-"));
		try {
			let cwd = path.join(root, "first-project");
			const session = {
				model: {},
				agent: { state: { tools: [] } },
				messages: [{ role: "assistant", content: [{ type: "text", text: "echo:dynamic-cwd-marker" }] }],
				async runEphemeralTurn() {
					return { replyText: generatedRule };
				},
			} as unknown as AgentSession;
			const settings = { getAgentDir: () => path.join(root, "agent") } as unknown as Settings;
			const service = new OmfgWorkerService({ session, settings, getCwd: () => cwd });
			const generated = await service.generate("omfg-cwd-request", "Save this rule to the active project");
			if (!generated.candidate.validated) throw new Error("fixture candidate did not match the prior assistant output");

			cwd = path.join(root, "second-project");
			const saved = await service.save({
				requestId: "omfg-cwd-request",
				fileContent: generated.candidate.fileContent,
				scope: "project",
				overwrite: false,
				acceptUnvalidated: false,
			});
			const expectedPath = path.join(cwd, ".omp", "rules", "cwd-rule.md");
			expect(saved.save).toEqual({ kind: "saved", path: expectedPath });
			expect(await Bun.file(expectedPath).text()).toBe(generated.candidate.fileContent);
			expect(await Bun.file(path.join(root, "first-project", ".omp", "rules", "cwd-rule.md")).exists()).toBe(false);
			service.close();
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("Cleanse captures the session cwd separately for each start", async () => {
		const observedCwds: string[] = [];
		vi.spyOn(cleanseModule, "runCleanse").mockImplementation(async options => {
			observedCwds.push(options.cwd ?? "");
			return {
				exitCode: 0,
				status: "clean",
				report: { checks: [], diagnostics: [], skipped: [] },
			} satisfies CleanseCommandResult;
		});
		let cwd = "/first/project";
		const session = { settings: {}, modelRegistry: {} } as unknown as AgentSession;
		const service = new CleanseWorkerService({ session, getCwd: () => cwd, onStateChanged() {} });
		const start = (runId: string) => service.start({
			op: "cleanse-start",
			runId,
			scope: { kind: "request", request: "Run the selected checker" },
			includeTests: false,
			maxAgents: 1,
		});

		expect(start("cleanse-cwd-one")).toEqual({ ok: true, runId: "cleanse-cwd-one" });
		cwd = "/second/project";
		await service.close();
		expect(start("cleanse-cwd-two")).toEqual({ ok: true, runId: "cleanse-cwd-two" });
		await service.close();
		expect(observedCwds).toEqual(["/first/project", "/second/project"]);
	});
});
