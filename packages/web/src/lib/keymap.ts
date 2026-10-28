import type { KeybindingsResponse } from "@omp-console/protocol";
import type { DeckApi } from "./api";
import { useEffect, useRef, useState } from "react";

export type DeckKeyAction =
	| "abortSession"
	| "cycleThinking"
	| "cycleModelForward"
	| "cycleModelBackward"
	| "selectModel"
	| "selectTemporaryModel"
	| "togglePlan"
	| "searchHistory"
	| "expandTools"
	| "toggleToolsVisibility"
	| "toggleThinkingVisibility"
	| "approve"
	| "dequeueMessage"
	| "retry"
	| "openAgentsHub"
	| "copyPrompt"
	| "pauseGoal"
	| "openSessionTree"
	| "openRewind";

export type KeybindingsApi = Pick<DeckApi, "keybindings">;

/** Adds the deck-only pause shortcut when the daemon's merged bindings omit it. */
export function withDeckKeybindingDefaults(keybindings: KeybindingsResponse): KeybindingsResponse {
	if (keybindings.bindings["app.goal.pause"] !== undefined) return keybindings;
	return {
		...keybindings,
		bindings: { ...keybindings.bindings, "app.goal.pause": ["alt+shift+g"] },
	};
}

export interface ParsedOmpKey {
	key: string;
	alt: boolean;
	ctrl: boolean;
	shift: boolean;
	super: boolean;
}

export interface KeyboardLike {
	key: string;
	code: string;
	altKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	shiftKey: boolean;
}

export const OMP_ACTIONS = {
	"app.interrupt": "abortSession",
	"app.thinking.cycle": "cycleThinking",
	"app.model.cycleForward": "cycleModelForward",
	"app.model.cycleBackward": "cycleModelBackward",
	"app.model.select": "selectModel",
	"app.model.selectTemporary": "selectTemporaryModel",
	"app.plan.toggle": "togglePlan",
	"app.history.search": "searchHistory",
	"app.tools.expand": "expandTools",
	"app.tools.toggleVisibility": "toggleToolsVisibility",
	"app.thinking.toggle": "toggleThinkingVisibility",
	"app.approval.approve": "approve",
	"app.message.dequeue": "dequeueMessage",
	"app.retry": "retry",
	"app.agents.hub": "openAgentsHub",
	"app.clipboard.copyPrompt": "copyPrompt",
	"app.goal.pause": "pauseGoal",
	"app.session.tree": "openSessionTree",
} as const satisfies Record<string, DeckKeyAction>;

export const KEY_ACTION_LABELS: Record<DeckKeyAction, string> = {
	abortSession: "Interrupt session",
	cycleThinking: "Cycle thinking level",
	cycleModelForward: "Next model",
	cycleModelBackward: "Previous model",
	selectModel: "Select model",
	selectTemporaryModel: "Select temporary model",
	togglePlan: "Toggle plan mode",
	searchHistory: "Search history",
	expandTools: "Expand tools",
	toggleToolsVisibility: "Show or hide tool activity",
	toggleThinkingVisibility: "Show or hide thinking",
	approve: "Approve pending request",
	dequeueMessage: "Dequeue message",
	retry: "Retry last turn",
	openAgentsHub: "Open agents hub",
	copyPrompt: "Copy composer prompt",
	pauseGoal: "Pause goal",
	openSessionTree: "Open session tree",
	openRewind: "Rewind to a message",
};

const keybindingsByApi = new WeakMap<KeybindingsApi, Promise<KeybindingsResponse>>();

/** Share one in-flight and settled keybinding request across every pane using the same DeckApi. */
export function keybindingsOnce(api: KeybindingsApi): Promise<KeybindingsResponse> {
	let request = keybindingsByApi.get(api);
	if (request === undefined) {
		request = api.keybindings();
		keybindingsByApi.set(api, request);
	}
	return request;
}

function normalizeKey(key: string): string | null {
	const normalized = key.trim().toLowerCase();
	if (normalized.length === 1) return normalized;
	switch (normalized) {
		case "esc":
		case "escape":
			return "escape";
		case "return":
		case "enter":
			return "enter";
		case "spacebar":
		case "space":
			return " ";
		case "up":
		case "arrowup":
			return "arrowup";
		case "down":
		case "arrowdown":
			return "arrowdown";
		case "left":
		case "arrowleft":
			return "arrowleft";
		case "right":
		case "arrowright":
			return "arrowright";
		case "del":
		case "delete":
			return "delete";
		case "backspace":
		case "tab":
		case "home":
		case "end":
		case "pageup":
		case "pagedown":
			return normalized;
		case "plus":
			return "+";
		default:
			return /^f(?:[1-9]|1[0-2])$/.test(normalized) ? normalized : null;
	}
}

/** Parse omp's `ctrl+shift+p` notation without silently accepting malformed modifiers. */
export function parseOmpKey(value: string): ParsedOmpKey | null {
	const parts = value.trim().toLowerCase().split("+");
	const keyPart = parts.pop();
	if (keyPart === undefined || keyPart === "") return null;
	const key = normalizeKey(keyPart);
	if (key === null) return null;
	const modifiers = new Set<string>();
	for (const part of parts) {
		const modifier = part.trim();
		if (modifier === "") return null;
		const canonical =
			modifier === "control" ? "ctrl" :
			modifier === "option" ? "alt" :
			["command", "cmd", "meta", "super"].includes(modifier) ? "super" : modifier;
		if (!["ctrl", "alt", "shift", "super"].includes(canonical) || modifiers.has(canonical)) return null;
		modifiers.add(canonical);
	}
	return {
		key,
		alt: modifiers.has("alt"),
		ctrl: modifiers.has("ctrl"),
		shift: modifiers.has("shift"),
		super: modifiers.has("super"),
	};
}

/** Match modifiers exactly; Option+letter uses the physical key because macOS changes event.key. */
export function matchesOmpKey(event: KeyboardLike, notation: string): boolean {
	const binding = parseOmpKey(notation);
	if (binding === null) return false;
	if (
		binding.alt !== event.altKey ||
		binding.ctrl !== event.ctrlKey ||
		binding.shift !== event.shiftKey ||
		binding.super !== event.metaKey
	) {
		return false;
	}
	const physicalLetter = binding.alt && /^[a-z]$/.test(binding.key) ? /^Key([A-Z])$/.exec(event.code)?.[1]?.toLowerCase() : undefined;
	return (physicalLetter ?? normalizeKey(event.key)) === binding.key;
}

export function actionForOmpId(id: string): DeckKeyAction | undefined {
	return OMP_ACTIONS[id as keyof typeof OMP_ACTIONS];
}

export function matchingDeckAction(event: KeyboardLike, bindings: Record<string, string[]>): DeckKeyAction | undefined {
	for (const [id, keys] of Object.entries(bindings)) {
		const action = actionForOmpId(id);
		if (action !== undefined && keys.some(key => matchesOmpKey(event, key))) return action;
	}
	return undefined;
}

interface FocusTarget extends EventTarget {
	closest?: (selectors: string) => Element | null;
	isContentEditable?: boolean;
	tagName?: string;
}

/** TUI-global actions do not steal keys from modal dialogs or another text editor. */
export function shouldSkipKeyTarget(target: EventTarget | null, composer: EventTarget | null): boolean {
	if (target === composer) return false;
	if (target === null) return false;
	const element = target as FocusTarget;
	if (element.isContentEditable === true) return true;
	if (element.closest?.('dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]')) return true;
	const tag = element.tagName?.toLowerCase();
	return tag === "input" || tag === "textarea" || tag === "select" || (element.closest?.('[role="textbox"], [contenteditable="true"]') ?? null) !== null;
}

export type DoubleEscapeSetting = KeybindingsResponse["doubleEscapeAction"];
export type DoubleEscapeResult = { action: "openRewind" | "openSessionTree" | null; nextAt: number };

/** A double Escape is available only on an empty composer and only for the configured action. */
export function resolveDoubleEscape(
	lastAt: number,
	now: number,
	empty: boolean,
	setting: DoubleEscapeSetting,
): DoubleEscapeResult {
	if (!empty || setting === "none") return { action: null, nextAt: 0 };
	if (lastAt > 0 && now >= lastAt && now - lastAt <= 500) {
		return { action: setting === "tree" ? "openSessionTree" : "openRewind", nextAt: 0 };
	}
	return { action: null, nextAt: now };
}

export interface KeymapState {
	keybindings: KeybindingsResponse | null;
	error: string | null;
}

export interface UseKeymapOptions {
	api: KeybindingsApi | undefined;
	enabled: boolean;
	composerRef: { current: HTMLTextAreaElement | null };
	getComposerText(): string;
	onAction(action: DeckKeyAction): void;
}

/** Loads omp's merged keybindings once per API instance and dispatches recognized web actions. */
export function useKeymap({ api, enabled, composerRef, getComposerText, onAction }: UseKeymapOptions): KeymapState {
	const [loaded, setLoaded] = useState<{ api: KeybindingsApi; keybindings: KeybindingsResponse } | null>(null);
	const [failure, setFailure] = useState<{ api: KeybindingsApi; error: string } | null>(null);
	const actionRef = useRef(onAction);
	actionRef.current = onAction;
	const textRef = useRef(getComposerText);
	textRef.current = getComposerText;
	const lastEscapeRef = useRef(0);

	useEffect(() => {
		if (api === undefined) return;
		let live = true;
		void keybindingsOnce(api).then(
			keybindings => {
				if (live) {
					setLoaded({ api, keybindings: withDeckKeybindingDefaults(keybindings) });
					setFailure(null);
				}
			},
			cause => {
				if (live) setFailure({ api, error: cause instanceof Error ? cause.message : "Keybindings unavailable" });
			},
		);
		return () => {
			live = false;
		};
	}, [api]);

	const keybindings = api !== undefined && loaded?.api === api ? loaded.keybindings : null;
	const error = api !== undefined && failure?.api === api ? failure.error : null;

	useEffect(() => {
		if (!enabled || keybindings === null) return;
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.defaultPrevented || event.isComposing || shouldSkipKeyTarget(event.target, composerRef.current)) return;
			if (event.key === "Escape") {
				const resolved = resolveDoubleEscape(
					lastEscapeRef.current,
					Date.now(),
					textRef.current().trim() === "",
					keybindings.doubleEscapeAction,
				);
				lastEscapeRef.current = resolved.nextAt;
				if (resolved.action !== null) {
					event.preventDefault();
					actionRef.current(resolved.action);
					return;
				}
			}
			const action = matchingDeckAction(event, keybindings.bindings);
			if (action === undefined) return;
			event.preventDefault();
			actionRef.current(action);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [enabled, keybindings, composerRef]);

	return { keybindings, error };
}

export const OPEN_KEYBINDINGS_EVENT = "omp-console:open-keybindings";
export const OPEN_BTW_EVENT = "omp-console:open-btw";
export const KEYMAP_ACTION_EVENT = "omp-console:keymap-action";

export interface KeymapActionDetail {
	action: DeckKeyAction;
	sessionId?: string;
}

export function dispatchKeymapAction(action: DeckKeyAction, sessionId?: string, target: EventTarget = globalThis): void {
	target.dispatchEvent(new CustomEvent<KeymapActionDetail>(KEYMAP_ACTION_EVENT, {
		detail: { action, ...(sessionId === undefined ? {} : { sessionId }) },
	}));
}

export function openKeybindings(target: EventTarget = globalThis): void {
	target.dispatchEvent(new Event(OPEN_KEYBINDINGS_EVENT));
}

export function openBtwPanel(target: EventTarget = globalThis): void {
	target.dispatchEvent(new Event(OPEN_BTW_EVENT));
}
