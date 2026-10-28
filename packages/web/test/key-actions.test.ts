import { describe, expect, it } from "bun:test";
import { nextRoleModel, nextThinkingLevel, runShellKeyAction, type ShellKeyContext } from "../src/lib/key-actions";
import { THINKING_LEVELS } from "../src/lib/session-model";

describe("nextRoleModel (omp Ctrl+P: slow, default, smol)", () => {
	const roles = { slow: "anthropic/opus", default: "anthropic/sonnet", smol: "openai/luna" };

	it("steps forward and backward with wrap-around, matching a bare model id", () => {
		expect(nextRoleModel(roles, "anthropic/opus", 1)).toBe("anthropic/sonnet");
		expect(nextRoleModel(roles, "luna", 1)).toBe("anthropic/opus");
		expect(nextRoleModel(roles, "anthropic/opus", -1)).toBe("openai/luna");
	});

	it("skips duplicate or unset roles and gives up with fewer than two distinct models", () => {
		expect(nextRoleModel({ slow: "a/x", default: "a/x", smol: "b/y" }, "a/x", 1)).toBe("b/y");
		expect(nextRoleModel({ default: "a/x" }, "a/x", 1)).toBeNull();
	});

	it("starts at the first role when the current model is not a role model", () => {
		expect(nextRoleModel(roles, "other/model", 1)).toBe("anthropic/opus");
		expect(nextRoleModel(roles, undefined, -1)).toBe("openai/luna");
	});
});

describe("nextThinkingLevel (omp Shift+Tab)", () => {
	it("wraps from the last level to the first and treats an unknown level as before the first", () => {
		expect(nextThinkingLevel(THINKING_LEVELS.at(-1))).toBe(THINKING_LEVELS[0]!);
		expect(nextThinkingLevel(undefined)).toBe(THINKING_LEVELS[0]!);
	});
});

describe("runShellKeyAction", () => {
	function context(calls: string[]): ShellKeyContext {
		return {
			rootAgentId: "Main",
			thinkingLevel: undefined,
			modelId: undefined,
			planModeEnabled: true,
			listModels: async () => ({ models: [], roles: {} }),
			setThinking: async () => {},
			setModel: async () => {},
			sessionOp: async op => {
				calls.push(JSON.stringify(op));
			},
			setPlanMode: async enabled => {
				calls.push(`plan:${enabled}`);
			},
			runCommand: async text => {
				calls.push(text);
			},
			openControls: () => calls.push("controls"),
			openAgents: () => calls.push("agents"),
			openTree: () => calls.push("tree"),
		};
	}

	it("maps plan toggle, retry and dequeue to omp's controls and leaves composer actions alone", async () => {
		const calls: string[] = [];
		const ctx = context(calls);
		expect(await runShellKeyAction("togglePlan", ctx)).toBe(true);
		expect(await runShellKeyAction("retry", ctx)).toBe(true);
		expect(await runShellKeyAction("dequeueMessage", ctx)).toBe(true);
		expect(await runShellKeyAction("copyPrompt", ctx)).toBe(false);
		expect(calls).toEqual(["plan:false", "/retry", '{"op":"dequeue"}']);
	});
});
