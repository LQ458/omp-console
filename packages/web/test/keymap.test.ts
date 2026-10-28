import { describe, expect, it } from "bun:test";
import type { KeybindingsResponse } from "@omp-console/protocol";
import {
	actionForOmpId,
	dispatchKeymapAction,
	keybindingsOnce,
	KEYMAP_ACTION_EVENT,
	matchesOmpKey,
	matchingDeckAction,
	OMP_ACTIONS,
	parseOmpKey,
	resolveDoubleEscape,
	shouldSkipKeyTarget,
	type KeymapActionDetail,
	withDeckKeybindingDefaults,
} from "../src/lib/keymap";

function keyEvent(key: string, options: Partial<{ code: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }> = {}) {
	return {
		key,
		code: options.code ?? "",
		altKey: options.altKey ?? false,
		ctrlKey: options.ctrlKey ?? false,
		metaKey: options.metaKey ?? false,
		shiftKey: options.shiftKey ?? false,
	};
}

const keybindings: KeybindingsResponse = {
	bindings: {},
	doubleEscapeAction: "rewind",
};

describe("omp web keybindings", () => {
	it("parses modifier aliases and rejects malformed or duplicate modifiers", () => {
		expect(parseOmpKey("alt+shift+p")).toEqual({ key: "p", alt: true, ctrl: false, shift: true, super: false });
		expect(parseOmpKey("command+return")).toEqual({ key: "enter", alt: false, ctrl: false, shift: false, super: true });
		expect(parseOmpKey("ctrl++")).toBeNull();
		expect(parseOmpKey("alt+alt+m")).toBeNull();
		expect(parseOmpKey("hyper+m")).toBeNull();
	});

	it("matches physical Option letters on macOS while requiring the exact modifiers", () => {
		expect(matchesOmpKey(keyEvent("µ", { code: "KeyM", altKey: true }), "alt+m")).toBe(true);
		expect(matchesOmpKey(keyEvent("π", { code: "KeyP", altKey: true, shiftKey: true }), "alt+shift+p")).toBe(true);
		expect(matchesOmpKey(keyEvent("p", { code: "KeyP", ctrlKey: true, shiftKey: true }), "ctrl+shift+p")).toBe(true);
		expect(matchesOmpKey(keyEvent("p", { code: "KeyP", ctrlKey: true, altKey: true }), "ctrl+p")).toBe(false);
	});

	it("maps every supported binding to its omp console action and dispatches session-scoped actions", () => {
		for (const [id, action] of Object.entries(OMP_ACTIONS)) {
			expect(actionForOmpId(id)).toBe(action);
		}
		for (const [index, [id, action]] of Object.entries(OMP_ACTIONS).entries()) {
			const letter = String.fromCharCode(97 + index);
			expect(matchingDeckAction(keyEvent(letter, { ctrlKey: true, shiftKey: true }), { [id]: [`ctrl+shift+${letter}`] })).toBe(action);
		}
		expect(actionForOmpId("app.not-an-omp-console-action")).toBeUndefined();
		expect(matchingDeckAction(keyEvent("x"), { "app.unmapped": ["x"] })).toBeUndefined();

		const target = new EventTarget();
		const received: KeymapActionDetail[] = [];
		target.addEventListener(KEYMAP_ACTION_EVENT, event => {
			received.push((event as CustomEvent<KeymapActionDetail>).detail);
		});
		dispatchKeymapAction("togglePlan", "session-1", target);
		expect(received).toEqual([{ action: "togglePlan", sessionId: "session-1" }]);
	});

	it("adds the omp console pause shortcut only when the daemon has no configured binding", () => {
		const defaults = withDeckKeybindingDefaults(keybindings);
		expect(defaults.bindings["app.goal.pause"]).toEqual(["alt+shift+g"]);
		expect(matchingDeckAction(keyEvent("g", { altKey: true, shiftKey: true }), defaults.bindings)).toBe("pauseGoal");

		const override = withDeckKeybindingDefaults({
			...keybindings,
			bindings: { "app.goal.pause": ["ctrl+alt+p"] },
		});
		expect(override.bindings["app.goal.pause"]).toEqual(["ctrl+alt+p"]);
		const explicitlyUnbound = withDeckKeybindingDefaults({
			...keybindings,
			bindings: { "app.goal.pause": [] },
		});
		expect(explicitlyUnbound.bindings["app.goal.pause"]).toEqual([]);
	});

	it("blocks shortcuts in dialogs and non-composer editors but permits the active composer", () => {
		const editor = { tagName: "TEXTAREA", closest: () => null } as unknown as EventTarget;
		const dialogButton = { tagName: "BUTTON", closest: (selector: string) => selector.includes("dialog") ? {} as Element : null } as unknown as EventTarget;
		expect(shouldSkipKeyTarget(editor, null)).toBe(true);
		expect(shouldSkipKeyTarget(editor, editor)).toBe(false);
		expect(shouldSkipKeyTarget(dialogButton, null)).toBe(true);
		expect(shouldSkipKeyTarget({ tagName: "BUTTON" } as unknown as EventTarget, null)).toBe(false);
	});

	it("opens the configured action only on a second Escape within 500ms on an empty composer", () => {
		expect(resolveDoubleEscape(0, 100, true, "rewind")).toEqual({ action: null, nextAt: 100 });
		expect(resolveDoubleEscape(100, 600, true, "rewind")).toEqual({ action: "openRewind", nextAt: 0 });
		expect(resolveDoubleEscape(100, 601, true, "tree")).toEqual({ action: null, nextAt: 601 });
		expect(resolveDoubleEscape(100, 200, false, "rewind")).toEqual({ action: null, nextAt: 0 });
		expect(resolveDoubleEscape(100, 200, true, "none")).toEqual({ action: null, nextAt: 0 });
		expect(resolveDoubleEscape(100, 200, true, "tree")).toEqual({ action: "openSessionTree", nextAt: 0 });
	});

	it("shares one keybinding request per DeckApi instance across panes", async () => {
		let calls = 0;
		const response: KeybindingsResponse = { ...keybindings, bindings: { "app.interrupt": ["escape"] } };
		const api = { keybindings: async () => { calls++; return response; } };
		const [first, second] = await Promise.all([keybindingsOnce(api), keybindingsOnce(api)]);
		expect(calls).toBe(1);
		expect(first.bindings["app.interrupt"]).toEqual(["escape"]);
		expect(second.doubleEscapeAction).toBe("rewind");
	});
});
