import { describe, expect, test } from "bun:test";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { CommandRunner } from "../src/run-command";

describe("remote usage command results", () => {
	test("emits the rendered text with allow-listed structured usage fields and no raw credential data", async () => {
		const report: UsageReport = {
			provider: "anthropic",
			fetchedAt: 1_800_000_000_000,
			limits: [
				{
					id: "5h",
					label: "5 Hour",
					scope: { provider: "anthropic", accountId: "acct-1", windowId: "5h" },
					window: { id: "5h", label: "5 Hour", resetsAt: 1_800_000_600_000 },
					amount: { used: 42, limit: 100, remaining: 58, usedFraction: 0.42, unit: "percent" },
					status: "ok",
				},
			],
			metadata: { email: "operator@example.com", endpoint: "https://provider.invalid/?token=hidden" },
			raw: { access_token: "sk-ant-api03-fake-credential-value" },
		};
		const notices: Array<{ level: string; message: string; source?: string }> = [];
		const session = {
			isStreaming: false,
			isCompacting: false,
			model: undefined,
			sessionManager: { getCwd: () => "/tmp/deck-command-test" },
			settings: {},
			cachedUsageReports: [report],
			fetchUsageReports: async () => [report],
			getUsageReportingModelSelectors: () => [],
			emitNotice: (level: string, message: string, source?: string) => notices.push({ level, message, source }),
		} as unknown as AgentSession;

		await new CommandRunner({ session }).run("/usage");

		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatchObject({ level: "info", source: "deck-command:usage" });
		const payload: unknown = JSON.parse(notices[0]!.message);
		if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new Error("missing command payload");
		const result = payload as Record<string, unknown>;
		expect(result.type).toBe("deck-command-result");
		expect(result.text).toContain("5 Hour");
		expect(result.usageReports).toHaveLength(1);
		const serialized = JSON.stringify(result.usageReports);
		expect(serialized).not.toContain("fake-credential-value");
		expect(serialized).not.toContain("access_token");
		expect(serialized).not.toContain("provider.invalid");
	});
});
