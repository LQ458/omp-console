import { describe, expect, it } from "bun:test";
import type { KeyboardEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GuestClient } from "../src/lib/client";
import type { ComposerProps } from "../src/components/shell/Composer";
import { AskForm, clearRecoveredOfflineNote, Composer, registerDraftFlush, runComposerSendGate, shouldSubmitOnEnter } from "../src/components/shell/Composer";
import { encodeBase64Url } from "../src/lib/link";
import { DeckApi } from "../src/lib/api";

const LINK = `roomroomroom1234#${encodeBase64Url(new Uint8Array(32))}`;
const client = new GuestClient(LINK, "tester");

function props(uiRequest: ComposerProps["uiRequest"]): ComposerProps {
	return { client, phase: "live", readOnly: false, uiRequest, working: true, queuedMessageCount: 0 };
}

describe("Composer host UI requests", () => {
	it("renders selectable ask responses for mobile guests", () => {
		const html = renderToStaticMarkup(
			<Composer
				{...props({
					reqId: 1,
					kind: "select",
					title: "Continue?",
					options: ["Yes", { label: "No", description: "Stop here" }],
					selectionMarker: "radio",
				})}
			/>,
		);

		expect(html).toContain("Continue?");
		expect(html).toContain("Yes");
		expect(html).toContain("Stop here");
	});

	it("renders a submit field for custom ask responses", () => {
		const html = renderToStaticMarkup(
			<Composer {...props({ reqId: 2, kind: "editor", title: "Other", prefill: "draft" })} />,
		);

		expect(html).toContain("Other");
		expect(html).toContain("draft");
		expect(html).toContain("Submit");
	});

	it("keeps the editor submit enabled for whitespace-only drafts", () => {
		const html = renderToStaticMarkup(
			<Composer {...props({ reqId: 3, kind: "editor", title: "Other", prefill: "   " })} />,
		);

		const submit = { found: false, disabled: false };
		new HTMLRewriter()
			.on('button[title="submit response"]', {
				element(el) {
					submit.found = true;
					submit.disabled = el.hasAttribute("disabled");
				},
			})
			.transform(html);

		expect(submit.found).toBe(true);
		expect(submit.disabled).toBe(false);
	});
});

describe("recommended plan review asks", () => {
	it("keeps a multiline plan title readable and labels the recommended option", () => {
		const html = renderToStaticMarkup(
			<AskForm
				request={{
					reqId: 12,
					kind: "select",
					title: "Plan review\n1. Stabilize reconnection\n2. Add the regression test",
					options: ["Execute the plan", "Refine the plan", "Save and stop"],
					initialIndex: 1,
				}}
				working={false}
				live
				onRespond={() => {}}
				onAbort={() => {}}
			/>,
		);
		const recommended: string[] = [];
		new HTMLRewriter().on(".sh-ask-option", {
			element(element) {
				if (element.getAttribute("data-recommended") === "true") recommended.push(element.getAttribute("aria-label") ?? "");
			},
		}).transform(html);
		expect(html).toContain("Plan review\n1. Stabilize reconnection\n2. Add the regression test");
		expect(recommended).toEqual(["Refine the plan, recommended"]);
	});
});

describe("Composer input controls", () => {
	it("offers file attachment and shortcut controls when the daemon API is available", () => {
		const html = renderToStaticMarkup(<Composer {...props(null)} api={new DeckApi()} sessionId="session-1" />);
		expect(html).toContain('aria-label="keyboard shortcuts"');
		expect(html).toContain('aria-label="attach files"');
		expect(html).toContain('title="Attach files"');
	});
	it("uses the plain action placeholder and keeps shortcut help available", () => {
		const html = renderToStaticMarkup(<Composer {...props(null)} api={new DeckApi()} sessionId="session-1" />);
		expect(html).toContain('placeholder="Ask the agent to do something…  @file"');
		expect(html).toContain('aria-label="keyboard shortcuts"');
	});

	it("suggests a starter only in an empty session's placeholder on desktop, taking no room above the input", () => {
		const render = (extra: Partial<ComposerProps>) =>
			renderToStaticMarkup(<Composer {...props(null)} api={new DeckApi()} sessionId="session-1" {...extra} />);
		const empty = render({ emptySession: true });
		expect(empty).toContain("placeholder=\"Try “Summarize this repo” — press Tab\"");
		expect(empty).not.toContain("Suggested starter prompts");
		expect(render({ emptySession: false })).not.toContain("press Tab");
		// The phone's Actions panel carries suggestions; a touch keyboard has no Tab.
		expect(render({ emptySession: true, phoneLayout: true })).not.toContain("press Tab");
	});

	it("always offers Stop while working on touch: in the action row when it shows, else in the composer", () => {
		const stops = (html: string): number => html.split('aria-label="stop the current turn"').length - 1 + (html.split(">Stop<").length - 1);
		const focused = renderToStaticMarkup(<Composer {...props(null)} api={new DeckApi()} sessionId="session-1" touchLayout active />);
		const unfocused = renderToStaticMarkup(<Composer {...props(null)} api={new DeckApi()} sessionId="session-1" touchLayout active={false} />);
		const linkJoined = renderToStaticMarkup(<Composer {...props(null)} touchLayout active />);
		expect(stops(focused)).toBeGreaterThan(0);
		expect(stops(unfocused)).toBeGreaterThan(0);
		expect(stops(linkJoined)).toBeGreaterThan(0);
	});
});

type KeyEvt = KeyboardEvent<HTMLTextAreaElement>;

function keydown(key: string, opts: { shiftKey?: boolean; isComposing?: boolean } = {}): KeyEvt {
	return {
		key,
		shiftKey: opts.shiftKey ?? false,
		nativeEvent: { isComposing: opts.isComposing ?? false },
	} as KeyEvt;
}

describe("shouldSubmitOnEnter IME guard", () => {
	it("submits on a plain Enter with no composition", () => {
		expect(shouldSubmitOnEnter(keydown("Enter"), false)).toBe(true);
	});

	it("does not submit while nativeEvent.isComposing is true", () => {
		expect(shouldSubmitOnEnter(keydown("Enter", { isComposing: true }), false)).toBe(false);
	});

	it("does not submit while the WebKit composing ref is still set", () => {
		expect(shouldSubmitOnEnter(keydown("Enter"), true)).toBe(false);
	});

	it("does not submit on Shift+Enter (newline)", () => {
		expect(shouldSubmitOnEnter(keydown("Enter", { shiftKey: true }), false)).toBe(false);
	});

	it("ignores non-Enter keys", () => {
		expect(shouldSubmitOnEnter(keydown("a"), false)).toBe(false);
	});
});

describe("offline composer recovery", () => {
	it("keeps the typed draft and does not submit while offline or disconnected", () => {
		for (const [online, phase] of [[false, "live"], [true, "reconnecting"]] as const) {
			let draft = "keep this prompt";
			let saved = "";
			let sends = 0;
			const accepted = runComposerSendGate(
				online,
				phase,
				() => {
					saved = draft;
				},
				() => {
					sends++;
					draft = "";
				},
			);
			expect(accepted).toBe(false);
			expect(saved).toBe("keep this prompt");
			expect(draft).toBe("keep this prompt");
			expect(sends).toBe(0);
		}
	});

	it("clears the offline notice only after both connections recover", () => {
		const offline = {
			tone: "error" as const,
			text: "Not sent: offline. It stays here; send again when back online.",
			clearOnReconnect: true,
		};
		const unrelated = { tone: "error" as const, text: "The request failed." };

		expect(clearRecoveredOfflineNote(offline, false, "live")).toBe(offline);
		expect(clearRecoveredOfflineNote(offline, true, "reconnecting")).toBe(offline);
		expect(clearRecoveredOfflineNote(offline, true, "live")).toBeNull();
		expect(clearRecoveredOfflineNote(unrelated, true, "live")).toBe(unrelated);
	});

	it("flushes the current session draft on hidden, pagehide, and cleanup", () => {
		const win = new EventTarget();
		const doc = Object.assign(new EventTarget(), { hidden: false });
		const saved: Array<[string, string]> = [];
		let draft = "first";
		const dispose = registerDraftFlush("session-1", () => draft, (id, text) => saved.push([id, text]), win, doc);

		draft = "edited after debounce";
		doc.hidden = true;
		doc.dispatchEvent(new Event("visibilitychange"));
		draft = "last edit";
		win.dispatchEvent(new Event("pagehide"));
		dispose();

		expect(saved).toEqual([
			["session-1", "edited after debounce"],
			["session-1", "last edit"],
			["session-1", "last edit"],
		]);
	});
});
