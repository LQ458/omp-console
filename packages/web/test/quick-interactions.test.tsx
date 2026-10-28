import { describe, expect, it } from "bun:test";
import type { PendingUiRequest } from "@omp-console/protocol";
import type { KeyValueStorage } from "../src/lib/storage";
import { renderToStaticMarkup } from "react-dom/server";
import { PendingUiRequestView } from "../src/components/shell/InlineUiRequest";
import { AskForm, TouchActionRow } from "../src/components/shell/Composer";
import { QuickReplyButtons } from "../src/components/shell/QuickReplies";
import { fixtureEntries } from "../dev/fixture";
import {
	DEFAULT_QUICK_REPLIES,
	latestAgentAnswerEntryId,
	quickReplyDisposition,
	QUICK_REPLIES_STORAGE_KEY,
	readQuickReplies,
	writeQuickReplies,
} from "../src/lib/quick-replies";
import type { CollabUiRequest, SessionEntry } from "@oh-my-pi/pi-wire";

function memoryStorage(initial: string | null = null): { storage: KeyValueStorage; value(): string | null } {
	let stored = initial;
	return {
		storage: {
			getItem: key => key === QUICK_REPLIES_STORAGE_KEY ? stored : null,
			setItem: (key, value) => { if (key === QUICK_REPLIES_STORAGE_KEY) stored = value; },
			removeItem: key => { if (key === QUICK_REPLIES_STORAGE_KEY) stored = null; },
		},
		value: () => stored,
	};
}

function countElements(html: string, selector: string): number {
	let count = 0;
	new HTMLRewriter().on(selector, { element: () => { count++; } }).transform(html);
	return count;
}

function requestWithChoices(): PendingUiRequest {
	return {
		reqId: "9",
		kind: "select",
		title: "Choose a plan",
		options: [{ label: "Execute", description: "Run the plan" }, { label: "Refine" }, { label: "Save" }, { label: "Cancel" }],
		initialIndex: 1,
		at: 1,
	};
}

describe("touch waiting-list answers", () => {
	it("shows the first three choices and highlights the host recommendation", () => {
		const html = renderToStaticMarkup(
			<PendingUiRequestView request={requestWithChoices()} error={null} sent={false} pending={false} disabled={false} onAnswer={() => {}} onOpen={() => {}} />,
		);
		const recommended: string[] = [];
		new HTMLRewriter().on(".ui-request-choice", {
			element(element) {
				if (element.getAttribute("data-recommended") === "true") recommended.push(element.getAttribute("aria-label") ?? "");
			},
		}).transform(html);
		expect(countElements(html, ".ui-request-choice")).toBe(3);
		expect(recommended).toEqual(["Refine, recommended"]);
		expect(html).toContain("More…");
	});

	it("disables inline answer choices while the host request is pending", () => {
		const html = renderToStaticMarkup(
			<PendingUiRequestView request={requestWithChoices()} error={null} sent={false} pending disabled onAnswer={() => {}} onOpen={() => {}} />,
		);
		expect(countElements(html, '.ui-request-choice[disabled]')).toBe(3);
		expect(html).toContain("Sending answer…");
	});

	it("routes editor and multi-select asks to the open session instead of offering unsafe inline answers", () => {
		const editor: PendingUiRequest = { reqId: "10", kind: "editor", title: "Explain", at: 1, prefill: "draft" };
		const multi: PendingUiRequest = {
			reqId: "11", kind: "select", title: "Pick items", options: [{ label: "A" }, { label: "B" }], checkedIndices: [], markableCount: 2, at: 1,
		};
		for (const request of [editor, multi]) {
			const html = renderToStaticMarkup(
				<PendingUiRequestView request={request} error={null} sent={false} pending={false} disabled={false} onAnswer={() => {}} onOpen={() => {}} />,
			);
			expect(countElements(html, ".ui-request-choice")).toBe(0);
			expect(html).toContain("Open to answer");
		}
	});

	it("replaces answer controls with the optimistic sent state", () => {
		const successHtml = renderToStaticMarkup(
			<PendingUiRequestView request={requestWithChoices()} error={null} sent disabled pending={false} onAnswer={() => {}} onOpen={() => {}} />,
		);
		const settledHtml = renderToStaticMarkup(
			<PendingUiRequestView request={requestWithChoices()} error={null} sent disabled pending={false} successFeedback={false} onAnswer={() => {}} onOpen={() => {}} />,
		);
		expect(successHtml).toContain("Sent");
		expect(countElements(successHtml, ".dk-action-mark-success")).toBe(1);
		expect(countElements(successHtml, ".ui-request-choice")).toBe(0);
		expect(settledHtml).toContain("Sent");
		expect(countElements(settledHtml, ".dk-action-mark-success")).toBe(0);
	});
	it("hides internal skill approval correlation from the session composer", () => {
		const request: CollabUiRequest = {
			reqId: 21,
			kind: "select",
			title: "Install skill with scripts?\n@omp-console/review scripts:\n\n[omp-console-skill-approval:operation-21]",
			options: ["Yes", "No"],
			initialIndex: 0,
		};
		const html = renderToStaticMarkup(<AskForm request={request} working={false} live onRespond={() => {}} onAbort={() => {}} />);
		expect(html).toContain("Install skill with scripts?");
		expect(html).not.toContain("omp-console-skill-approval");
	});
});

describe("quick replies", () => {
	it("loads the fixed defaults and persists normalized edits without duplicate or blank rows", () => {
		const store = memoryStorage();
		expect(readQuickReplies(store.storage)).toEqual([...DEFAULT_QUICK_REPLIES]);
		expect(writeQuickReplies("  Yes  \n\nYes\nNo ", store.storage)).toBe(true);
		expect(readQuickReplies(store.storage)).toEqual(["Yes", "No"]);
		expect(JSON.parse(store.value() ?? "null")).toEqual(["Yes", "No"]);
	});

	it("falls back after corrupt storage and distinguishes send-now from edit-first replies at twelve characters", () => {
		const store = memoryStorage("{");
		expect(readQuickReplies(store.storage)).toEqual([...DEFAULT_QUICK_REPLIES]);
		expect(quickReplyDisposition("123456789012", false)).toBe("send");
		expect(quickReplyDisposition("1234567890123", false)).toBe("edit");
		expect(quickReplyDisposition("是", true)).toBe("edit");
	});

	it("renders fixed and generated reply choices together below an answer", () => {
		const html = renderToStaticMarkup(
			<QuickReplyButtons fixed={["继续", "好的"]} generated={["Try the reconnect path"]} onSend={() => {}} onEdit={() => {}} />,
		);
		expect(html).toContain('aria-label="Quick replies"');
		expect(html).toContain("继续");
		expect(html).toContain("Try the reconnect path");
		expect(html).toContain("tr-quick-reply-generated");
	});

	it("offers replies only for the newest assistant answer, never after a newer user prompt", () => {
		const answerBranch = fixtureEntries.slice(0, 2);
		expect(latestAgentAnswerEntryId(answerBranch)).toBe("e02");
		const newerUser: SessionEntry = { ...fixtureEntries[0]!, id: "new-user-prompt", parentId: "e02" };
		expect(latestAgentAnswerEntryId([...answerBranch, newerUser])).toBeNull();
	});

	it("sends complete generated phone suggestions but edits a truncated one", () => {
		expect(quickReplyDisposition("Run the focused tests.", true, true)).toBe("send");
		expect(quickReplyDisposition(`${"界".repeat(79)}…`, true, true)).toBe("edit");
	});

});

describe("touch session actions", () => {
	it("keeps the tablet touch row and its conditional Stop action", () => {
		const actions = (working: boolean): string[] => {
			const html = renderToStaticMarkup(
				<TouchActionRow
					working={working}
					draft=""
					promptActionsEnabled
					planModeEnabled={true}
					phoneLayout={false}
					phoneSuggestions={[]}
					phoneSuggestionStatus="idle"
					prompts={[]}
					promptUses={[]}
					quickReplies={null}
					lastLink={null}
					actionsOpen={false}
					onActionsOpenChange={() => {}}
					onAction={() => {}}
					onSendPrompt={() => true}
					onStop={() => {}}
					onAskAside={() => {}}
				/>,
			);
			const found: string[] = [];
			new HTMLRewriter().on(".cmp-touch-action", {
				element(element) {
					const action = element.getAttribute("data-action");
					if (action !== null) found.push(action);
				},
			}).transform(html);
			return found;
		};
		expect(actions(true)).toEqual(["stop", "pause", "retry", "rewind", "aside", "plan", "model"]);
		expect(actions(false)).toEqual(["pause", "retry", "rewind", "aside", "plan", "model"]);
	});

	it("keeps the phone quick bar while exposing all ten suggestions and bounded usual actions", () => {
		const suggestions = Array.from({ length: 10 }, (_, index) => `Suggestion ${index + 1}`);
		const props = {
			working: true,
			draft: "",
			promptActionsEnabled: true,
			planModeEnabled: true,
			phoneLayout: true,
			quickReplies: <QuickReplyButtons fixed={["好的"]} generated={suggestions} tileLayout onSend={() => {}} onEdit={() => {}} />,
			phoneSuggestions: suggestions,
			phoneSuggestionStatus: "ready" as const,
			prompts: [],
			promptUses: [],
			lastLink: "https://example.com",
			onActionsOpenChange: () => {},
			onAction: () => {},
			onSendPrompt: () => true,
			onStop: () => {},
			onAskAside: () => {},
		};
		const open = renderToStaticMarkup(<TouchActionRow {...props} actionsOpen />);
		expect(open).toContain('aria-expanded="true"');
		expect(open).toContain("Suggestions");
		expect(open).toContain("Usual actions");
		expect(countElements(open, ".tr-quick-reply-card")).toBe(10);
		expect(countElements(open, ".cmp-action-tile")).toBeLessThanOrEqual(21);
		expect(countElements(open, ".tr-quick-reply-card") + countElements(open, ".cmp-action-tile")).toBeLessThanOrEqual(31);
		expect(countElements(open, '.cmp-action-tile[data-action="overnight"]')).toBe(0);
		const overnightEnabled = renderToStaticMarkup(<TouchActionRow {...props} actionsOpen overnightEnabled />);
		expect(countElements(overnightEnabled, '.cmp-action-tile[data-action="overnight"]')).toBe(1);
		expect(overnightEnabled).toContain("Overnight run");
		expect(countElements(open, '.cmp-touch-shortcut[data-action="stop"]')).toBe(1);
		expect(countElements(open, '.cmp-touch-shortcut[data-action="rewind"]')).toBe(1);
		expect(countElements(open, ".cmp-action-toggle")).toBe(1);

		const closed = renderToStaticMarkup(<TouchActionRow {...props} actionsOpen={false} />);
		expect(closed).toContain('aria-expanded="false"');
		expect(countElements(closed, ".cmp-action-tile")).toBe(0);
		expect(countElements(closed, '.cmp-touch-shortcut[data-action="stop"]')).toBe(1);
		expect(countElements(closed, '.cmp-touch-shortcut[data-action="retry"]')).toBe(0);
		const idle = renderToStaticMarkup(<TouchActionRow {...props} working={false} actionsOpen={false} />);
		expect(countElements(idle, '.cmp-touch-shortcut[data-action="stop"]')).toBe(0);
		expect(countElements(idle, '.cmp-touch-shortcut[data-action="retry"]')).toBe(1);
	});
	it("disables prompt tiles when sending is unavailable but leaves them queueable while working", () => {
		const props = {
			working: true,
			draft: "",
			promptActionsEnabled: true,
			planModeEnabled: true,
			phoneLayout: true,
			quickReplies: null,
			phoneSuggestions: [],
			phoneSuggestionStatus: "idle" as const,
			prompts: [],
			promptUses: [],
			lastLink: null,
			actionsOpen: true,
			onActionsOpenChange: () => {},
			onAction: () => {},
			onSendPrompt: () => false,
			onStop: () => {},
			onAskAside: () => {},
		};
		const promptTile = (html: string): boolean | undefined => {
			let disabled: boolean | undefined;
			new HTMLRewriter().on(".cmp-action-tile", {
				element(element) {
					if (element.getAttribute("data-action") === "prompt:run the tests") {
						disabled = element.getAttribute("disabled") !== null;
					}
				},
			}).transform(html);
			return disabled;
		};
		const disabled = renderToStaticMarkup(<TouchActionRow {...props} promptActionsEnabled={false} />);
		expect(promptTile(disabled)).toBe(true);
		const queueable = renderToStaticMarkup(<TouchActionRow {...props} promptActionsEnabled />);
		expect(promptTile(queueable)).toBe(false);
	});

});
