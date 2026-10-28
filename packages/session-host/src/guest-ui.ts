/**
 * `ExtensionUIContext` for a worker without a terminal: every dialog (the `ask` tool's select and
 * editor prompts, extension confirm/input/select/editor, tool approvals) is mirrored to writable
 * collab guests through `CollabHost.requestGuestUi` and waits for a `ui-response`.
 *
 * - There is no local dialog to race, so this surface enforces `dialogOptions.timeout` itself
 *   (the TUI's dialog components do that locally) and reports `onTimeout`/`onTimeoutStart`.
 * - Requests are registered with `retainOnReconnect`: a guest that drops and comes back is shown the
 *   same question again by the host's hello handler, and the wait is never left without an owner.
 * - The pending request is released on every exit path (answer, timeout, caller abort, room end).
 * - `askDialog` is intentionally absent: the `ask` tool then falls back to `select`/`editor`, which
 *   are the same wire requests the TUI sends to guests, and the tool arms its own cancellation.
 */
import type { CollabUiRequestDraft, CollabUiSelectItem } from "@oh-my-pi/pi-wire";
import type { ExtUiHooks } from "./ext-ui";
import { logger } from "@oh-my-pi/pi-utils";
import type { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import type {
	ExtensionApprovalAnswer,
	ExtensionApprovalPrompt,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionUISelectItem,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { approvalAnswerForChoice, approvalChoiceLabels } from "@oh-my-pi/pi-coding-agent/tools/approval";
import { theme } from "@oh-my-pi/pi-tui/theme";

export type PendingDialogKind = "answer" | "approval";

export interface GuestUiHooks {
	/** The room's current host; absent before the room is live and after it ended. */
	host(): CollabHost | undefined;
	/** A dialog is now waiting for a guest. `summary` is its title. */
	opened(kind: PendingDialogKind, summary: string): number;
	/** The dialog with this id settled (answered, timed out, aborted or the room went away). */
	closed(id: number): void;
	/** The overnight default deadline for dialogs without their own timeout. */
	askTimeoutSec?: () => number | undefined;
	/** Published whenever overnight mode resolves a dialog without a guest answer. */
	autoAnswer?: (answer: { at: number; question: string; answer: string }) => void;
	/** Where `setStatus`, `setWidget` and `notify` go; absent, they only reach the logger (`notify`) or nowhere. */
	extUi?: ExtUiHooks;
}

function toWireOptions(options: ExtensionUISelectItem[]): CollabUiSelectItem[] {
	return options.map(option =>
		typeof option === "string"
			? option
			: option.description
				? { label: option.label, description: option.description }
				: { label: option.label },
	);
}

function timeoutAnswer(kind: PendingDialogKind, request: CollabUiRequestDraft): string {
	if (kind === "approval") return "Deny";
	if (request.kind !== "select" || request.markableCount === undefined || request.markableCount <= 0) return "cancelled/default";
	const optionCount = Math.min(request.markableCount, request.options.length);
	const checked = request.checkedIndices?.filter(index => Number.isInteger(index) && index >= 0 && index < optionCount) ?? [];
	const indices = checked.length > 0
		? checked
		: [Math.min(Math.max(request.initialIndex ?? 0, 0), optionCount - 1)];
	return indices.map(index => {
		const option = request.options[index]!;
		return (typeof option === "string" ? option : option.label).replace(/ \(Recommended\)$/, "");
	}).join(", ");
}
async function resolveWithoutGuest(
	hooks: GuestUiHooks,
	kind: PendingDialogKind,
	request: CollabUiRequestDraft,
	dialogOptions: ExtensionUIDialogOptions | undefined,
): Promise<string | undefined> {
	const timeoutSec = hooks.askTimeoutSec?.();
	const timeoutMs = dialogOptions?.timeout ?? (timeoutSec === undefined ? undefined : timeoutSec * 1000);
	if (dialogOptions?.signal?.aborted || timeoutMs === undefined || timeoutMs <= 0) return undefined;

	const timeout = Promise.withResolvers<boolean>();
	const timer = setTimeout(() => timeout.resolve(true), timeoutMs);
	const onAbort = (): void => timeout.resolve(false);
	dialogOptions?.signal?.addEventListener("abort", onAbort, { once: true });
	dialogOptions?.onTimeoutStart?.();
	try {
		if (!(await timeout.promise) || dialogOptions?.signal?.aborted) return undefined;
	} finally {
		clearTimeout(timer);
		dialogOptions?.signal?.removeEventListener("abort", onAbort);
	}

	dialogOptions?.onTimeout?.();
	const answer = timeoutAnswer(kind, request);
	hooks.autoAnswer?.({ at: Date.now(), question: request.title, answer });
	return kind === "answer" && request.kind === "select" && request.markableCount !== undefined ? answer : undefined;
}


export function createGuestUiContext(hooks: GuestUiHooks): ExtensionUIContext {
	/** Resolves to the guest's string answer, or `undefined` for a cancel, timeout, abort or lost room. */
	async function dialog(
		kind: PendingDialogKind,
		request: CollabUiRequestDraft,
		dialogOptions: ExtensionUIDialogOptions | undefined,
	): Promise<string | undefined> {
		const host = hooks.host();
		if (!host) return resolveWithoutGuest(hooks, kind, request, dialogOptions);
		const own = new AbortController();
		const signal = dialogOptions?.signal ? AbortSignal.any([dialogOptions.signal, own.signal]) : own.signal;
		const pending = host.requestGuestUi(request, signal, { retainOnReconnect: true });
		if (!pending) return resolveWithoutGuest(hooks, kind, request, dialogOptions);
		const dialogId = hooks.opened(kind, request.title);
		const defaultTimeoutSec = hooks.askTimeoutSec?.();
		const timeoutMs = dialogOptions?.timeout ?? (defaultTimeoutSec === undefined ? undefined : defaultTimeoutSec * 1000);
		const timeoutFinished = Promise.withResolvers<void>();
		const timer =
			typeof timeoutMs === "number" && timeoutMs > 0
				? setTimeout(() => {
						dialogOptions?.onTimeout?.();
						hooks.autoAnswer?.({ at: Date.now(), question: request.title, answer: timeoutAnswer(kind, request) });
						own.abort();
						timeoutFinished.resolve();
					}, timeoutMs)
				: undefined;
		dialogOptions?.onTimeoutStart?.();
		try {
			const result = await pending;
			if (result.kind !== "answered") {
				if (result.kind === "unavailable" && timer !== undefined && !dialogOptions?.signal?.aborted) {
					await timeoutFinished.promise;
					const answer = timeoutAnswer(kind, request);
					return kind === "answer" && request.kind === "select" && request.markableCount !== undefined
						? answer
						: undefined;
				}
				return undefined;
			}
			return typeof result.value === "string" ? result.value : undefined;
		} finally {
			clearTimeout(timer);
			// A caller abort or timeout settles the host request through the signal; a teardown already has.
			own.abort();
			hooks.closed(dialogId);
		}
	}

	const ui: ExtensionUIContext = {
		timeoutStartsOnPresentation: true,
		supportsEditor: true,
		select: (title, options, dialogOptions) =>
			dialog(
				"answer",
				{
					kind: "select",
					title,
					options: toWireOptions(options),
					initialIndex: dialogOptions?.initialIndex,
					selectionMarker: dialogOptions?.selectionMarker,
					checkedIndices: dialogOptions?.checkedIndices ? [...dialogOptions.checkedIndices] : undefined,
					markableCount: dialogOptions?.markableCount,
					helpText: dialogOptions?.helpText,
				},
				dialogOptions,
			),
		confirm: async (title, message, dialogOptions) =>
			(await dialog(
				"answer",
				{ kind: "select", title: `${title}\n${message}`, options: ["Yes", "No"] },
				dialogOptions,
			)) === "Yes",
		input: (title, placeholder, dialogOptions) =>
			dialog("answer", { kind: "editor", title, prefill: placeholder }, dialogOptions),
		editor: (title, prefill, dialogOptions) => dialog("answer", { kind: "editor", title, prefill }, dialogOptions),
		approve: async (
			prompt: ExtensionApprovalPrompt,
			dialogOptions?: ExtensionUIDialogOptions,
		): Promise<ExtensionApprovalAnswer> => {
			const choice = await dialog(
				"approval",
				{ kind: "select", title: prompt.full, options: approvalChoiceLabels(prompt) },
				dialogOptions,
			);
			return approvalAnswerForChoice(prompt, choice);
		},
		notify: (message, type) => {
			logger.info("extension notice", { type: type ?? "info", message });
			hooks.extUi?.notify(message, type);
		},
		onTerminalInput: () => () => {},
		setStatus: (key, text) => hooks.extUi?.setStatus(key, text),
		setWorkingMessage: () => {},
		setWidget: (key, content) => hooks.extUi?.setWidget(key, content),
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: () => Promise.resolve(undefined as never),
		setEditorText: () => {},
		pasteToEditor: () => {},
		getEditorText: () => "",
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		get theme() {
			return theme;
		},
		getAllThemes: () => Promise.resolve([]),
		getTheme: () => Promise.resolve(undefined),
		setTheme: () => Promise.resolve({ success: false, error: "themes are not available in a headless worker" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
	return ui;
}
