import { describe, expect, it } from "bun:test";
import type { CatalogCommand, JournalEvent, SessionRecipe } from "@omp-console/protocol";
import {
	buildPhoneActionPanel,
	normalizePhonePrompt,
	PHONE_SUGGESTION_LIMIT,
	PHONE_USUAL_ACTION_LIMIT,
} from "../src/lib/phone-actions";
import type { PhoneActionInput } from "../src/lib/phone-actions";
import { PromptHistory } from "../src/lib/prompt-history";

const now = 1_800_000_000_000;

function input(overrides: Partial<PhoneActionInput> = {}): PhoneActionInput {
	return {
		events: [],
		prompts: [],
		promptUses: [],
		savedReplies: [],
		suggestions: [],
		commands: [],
		recipes: [],
		working: false,
		now,
		...overrides,
	};
}

function usage(at: number, detail: string, feature = "phone-actions", action = "use"): JournalEvent {
	return { at, feature, action, outcome: "ok", detail };
}

function command(name: string): CatalogCommand {
	return { name, source: "builtin", remote: true };
}

function recipe(id: string, name = id): SessionRecipe {
	return { id, name, cwd: "/repo", machineId: "local", prompt: "Start", createdAt: now, updatedAt: now };
}

describe("phone Actions ranking", () => {
	it("ranks repeated use above single use while decaying old activity behind recent use", () => {
		const frequent = buildPhoneActionPanel(input({
			events: [
				usage(now - 60 * 60 * 1_000, "action:rewind"),
				usage(now - 2 * 60 * 60 * 1_000, "action:rewind"),
				usage(now - 60 * 60 * 1_000, "action:aside"),
			],
		})).usualActions;
		expect(frequent.findIndex(action => action.kind === "action" && action.id === "rewind"))
			.toBeLessThan(frequent.findIndex(action => action.kind === "action" && action.id === "aside"));

		const recency = buildPhoneActionPanel(input({
			events: [
				usage(now - 21 * 24 * 60 * 60 * 1_000, "action:rewind"),
				usage(now - 20 * 24 * 60 * 60 * 1_000, "action:rewind"),
				usage(now - 1_000, "action:aside"),
			],
		})).usualActions;
		expect(recency.findIndex(action => action.kind === "action" && action.id === "aside"))
			.toBeLessThan(recency.findIndex(action => action.kind === "action" && action.id === "rewind"));
	});

	it("normalizes repeated prompts, keeps only repeats, and removes suggestions from usual actions", () => {
		const repeated = buildPhoneActionPanel(input({
			prompts: ["Re-run tests", "  RE-RUN   TESTS!"],
			suggestions: ["re-run tests"],
		}));
		expect(normalizePhonePrompt("  ＲＥ－ＲＵＮ   TESTS！ ")).toBe("re-run tests");
		expect(repeated.usualActions.some(action => action.kind === "prompt" && normalizePhonePrompt(action.text) === "re-run tests")).toBe(false);

		const distinct = buildPhoneActionPanel(input({ prompts: ["Check the tests", " CHECK  THE TESTS!", "One-off prompt"] }));
		const reused = distinct.usualActions.filter(action => action.kind === "prompt" && normalizePhonePrompt(action.text) === "check the tests");
		expect(reused).toHaveLength(1);
		expect(reused[0]?.kind === "prompt" ? reused[0].text : "").toBe("CHECK  THE TESTS!");
		expect(distinct.usualActions.some(action => action.kind === "prompt" && action.text === "One-off prompt")).toBe(false);
	});

	it("fills defaults and keeps a saved recipe available when no history exists", () => {
		const usual = buildPhoneActionPanel(input({ savedReplies: ["Review the diff"], recipes: [recipe("saved-one", "Recheck relay")]})).usualActions;
		const labels = usual.map(action => action.label);
		for (const label of ["Retry", "Rewind", "Ask aside", "Plan mode", "Model", "Compact", "Open last link", "New session", "Search prompts", "Run the tests", "Review the diff", "Recheck relay"]) {
			expect(labels).toContain(label);
		}
	});
	it("keeps terminal-only omp console commands available in phone Actions without usage history", () => {
		const usual = buildPhoneActionPanel(input({
			commands: [command("tan"), command("omfg"), command("cleanse")],
		})).usualActions;
		expect(usual.filter(action => action.kind === "command").map(action => action.command.name)).toEqual([
			"tan",
			"omfg",
			"cleanse",
		]);
	});

	it("caps ten distinct suggestions and twenty deduplicated usual actions", () => {
		const suggestions = ["command-0", "COMMAND-0", ...Array.from({ length: 14 }, (_, index) => `suggestion-${index}`)];
		const panel = buildPhoneActionPanel(input({
			suggestions,
			commands: Array.from({ length: 40 }, (_, index) => command(`command-${index}`)),
			recipes: Array.from({ length: 12 }, (_, index) => recipe(`recipe-${index}`, `Recipe ${index}`)),
		}));

		expect(panel.suggestions).toHaveLength(PHONE_SUGGESTION_LIMIT);
		expect(panel.usualActions).toHaveLength(PHONE_USUAL_ACTION_LIMIT);
		const suggestionKeys = new Set(panel.suggestions.map(normalizePhonePrompt));
		for (const action of panel.usualActions) {
			if (action.kind !== "prompt") continue;
			expect(suggestionKeys.has(normalizePhonePrompt(action.text))).toBe(false);
		}
	});

	it("ranks consecutive repeated sends recorded through PromptHistory", () => {
		const history = new PromptHistory(undefined);
		for (let index = 0; index < 6; index++) history.push("session-1", "Audit the retry path");
		const panel = buildPhoneActionPanel(input({
			prompts: history.entries("session-1"),
			promptUses: history.promptUses("session-1"),
		}));
		expect(panel.usualActions.some(action => action.kind === "prompt" && normalizePhonePrompt(action.text) === "audit the retry path")).toBe(true);
	});

	it("keeps omp console actions when suggestions share their labels", () => {
		const panel = buildPhoneActionPanel(input({ suggestions: ["Retry", "Model"] }));
		expect(panel.usualActions).toContainEqual(expect.objectContaining({ kind: "action", id: "retry", label: "Retry" }));
		expect(panel.usualActions).toContainEqual(expect.objectContaining({ kind: "action", id: "model", label: "Model" }));
	});
});
