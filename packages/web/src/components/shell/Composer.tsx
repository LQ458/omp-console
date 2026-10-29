import type { CollabUiRequest } from "@oh-my-pi/pi-wire";
import { BookmarkPlus, Compass, Cpu, ExternalLink, Grid2X2, ListChecks, MessageSquare, Moon, Paperclip, Pause, Play, Plus, RotateCcw, Search, SendHorizontal, Square, Terminal, Undo2, X } from "lucide-react";
import type { ClipboardEvent, DragEvent, KeyboardEvent, ReactNode, RefObject } from "react";
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DeckApi } from "../../lib/api";
import { visibleUiRequestTitle } from "../../lib/ui-request-title";
import { sessionKey } from "../../lib/machines";
import type { ConnectionPhase, GuestClient } from "../../lib/client";
import type { VisibilityTarget } from "../../lib/lifecycle";
import { recordUsage } from "../../lib/journal";
import { buildPhoneActionPanel, type PhoneUsualAction } from "../../lib/phone-actions";
import { QUICK_REPLIES_CHANGED_EVENT, readQuickReplies } from "../../lib/quick-replies";
import type { QuickReplyStatus } from "./QuickReplies";
import { copyText } from "../catalog/clipboard";
import { BtwPanel, type BtwTurn } from "../composer/BtwPanel";
import { detectShellMode, findGitHubReference, githubReferenceUri, parseBtwCommand, parseShellInput, type ShellInputMode } from "../composer/input-mode";
import { KeybindingsSheet } from "../keys/KeybindingsSheet";
import { RewindSheet } from "../rewind/RewindSheet";
import {
	applyMention,
	formatDroppedPath,
	formatFileMention,
	formatModelMention,
	type Insertion,
	insertAtSelection,
	planDrop,
	relativeToCwd,
} from "../../lib/mentions";
import { COMPOSER_INSERT_EVENT, type ComposerInsertDetail, commandEquivalent, openPanel, withOvernightCommand } from "../../lib/palette";
import { caretLines, HistoryCursor, promptHistory, PROMPT_HISTORY_CHANGED_EVENT } from "../../lib/prompt-history";
import type { PromptUse } from "../../lib/prompt-history";
import {
	dispatchKeymapAction,
	OPEN_BTW_EVENT,
	OPEN_KEYBINDINGS_EVENT,
	type DeckKeyAction,
	useKeymap,
} from "../../lib/keymap";
import type { CatalogCommand, JournalEvent, SessionRecipe } from "@omp-console/protocol";
import { type CommandOutcome, executeCommand } from "../catalog/actions";
import { catalogCache } from "../../lib/catalog";
import { OmpEquivalent } from "../catalog/OmpEquivalent";
import { AttachmentChips } from "../composer/AttachmentChips";
import { UploadChips, type UploadChip } from "../composer/UploadChips";
import { ComposerSuggest, suggestOptionId } from "../composer/ComposerSuggest";
import {
	attachRejection,
	fileToBase64,
	type ImageAttachment,
	isPromptImage,
	rejectionMessage,
	submitPrompt,
	supportsPromptImages,
} from "../composer/images";
import { useAssist } from "../composer/use-assist";
import { QueueChips, queueTracker } from "./QueueChips";
import { publishTranscriptOutput } from "../transcript/events";
import { motionLevel } from "../../lib/motion";
import { openExternalLink } from "../transcript/clipboard";
import "../composer/composer.css";
import { ActionFeedbackMark, ActionFeedbackMessage } from "./ActionFeedback";
import { useActionFeedback } from "../../lib/action-feedback";
import type { ActionFeedbackState } from "../../lib/action-feedback";

import { notifyToast } from "./Toasts";
import { TipCard } from "../tips/TipCard";

const EMPTY_PHONE_SUGGESTIONS: readonly string[] = [];
const STARTER_PROMPTS = ["Summarize this repo", "Run the tests", "What changed today?"] as const;
const COMPOSER_TIPS = [
	{ id: "composer-mentions", text: "Type @file, /command, or ^model for suggestions." },
	{ id: "composer-drop-files", text: "Drop files on the composer to attach them." },
] as const;

export interface ComposerProps {
	client: GuestClient;
	phase: ConnectionPhase;
	readOnly: boolean;
	/** Pending host-side UI request this guest can answer. */
	uiRequest: CollabUiRequest | null;
	/** Host agent turn in flight. */
	working: boolean;
	/** The host worker is parked at a safe boundary. */
	paused?: boolean;
	onTogglePause?(): void;
	/** Prompts queued behind the running turn. */
	queuedMessageCount: number;
	/** Daemon API and session id: enable `@file`, `/command` and `^model` suggestions and the catalog button. */
	api?: Pick<
		DeckApi,
		"fileSuggestions" | "listModels" | "catalog" | "runCommand" | "sessionOp" | "sessionOpV3" | "keybindings" | "uploadFile" | "readJournal"
		| "listRecipes"
		| "startRecipe"
	>;
	sessionId?: string;
	/** Whether local file paths resolve on the machine running this session. */
	sessionOnLocalMachine?: boolean;
	/** The pane this composer lives in has focus. Text other panels insert (`COMPOSER_INSERT_EVENT`) goes to the active composer only. Default true. */
	active?: boolean;
	/** Phone, tablet, or coarse-pointer layout. */
	touchLayout?: boolean;
	/** The narrow phone layout gets an action panel; tablet touch keeps its existing row. */
	phoneLayout?: boolean;
	quickReplies?: ReactNode;
	phoneSuggestions?: readonly string[];
	phoneSuggestionStatus?: QuickReplyStatus;
	lastLink?: string | null;
	actionsOpen?: boolean;
	onActionsOpenChange?(open: boolean): void;
	planModeEnabled?: boolean | null;
	/** Shows quiet starter prompts while an empty session is ready for input. */
	emptySession?: boolean;
	overnightEnabled?: boolean;
}

/** Textarea metrics: line-height 20px + 8px vertical padding × 2 (kept in sync with shell.css). */
const LINE_PX = 20;
const PAD_Y = 16;
const MAX_ROWS = 8;
/** Delay before an edit is written to the session's stored draft. */
const DRAFT_SAVE_MS = 400;
const SEND_FEEDBACK_PENDING_MS = 120;
/** `/name` or `/name args`: a typed-out slash command. */
const SLASH_COMMAND_RE = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/;

/** A shrinking composer waits this long after the last edit, so a line that wraps and unwraps while typing (IME composition, backspace at a line end) does not bounce the transcript. */
const SHRINK_DELAY_MS = 700;
/** Must match the daemon's raw upload limit. */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * Fits the textarea to its content and returns whether a shrink was deferred. Growth applies at once; a shrink
 * applies at once only when `shrinkNow`. Measuring collapses the textarea, so the parent's height is pinned
 * meanwhile and the composer box never changes size mid-measure.
 */
function autosize(el: HTMLTextAreaElement | null, shrinkNow: boolean): boolean {
	if (!el) return false;
	const max = MAX_ROWS * LINE_PX + PAD_Y;
	const box = el.parentElement;
	const pinned = box?.style.height ?? "";
	if (box) box.style.height = `${box.offsetHeight}px`;
	const current = el.offsetHeight;
	const scrollTop = el.scrollTop;
	el.style.height = "0px";
	const content = el.scrollHeight;
	const target = Math.max(LINE_PX + PAD_Y, Math.min(content, max));
	const defer = !shrinkNow && target < current;
	el.style.height = `${defer ? current : target}px`;
	el.style.overflowY = content > max ? "auto" : "hidden";
	el.scrollTop = scrollTop;
	if (box) box.style.height = pinned;
	return defer;
}

/**
 * Decides whether an Enter keydown should commit the composer. Returns `false` while an IME
 * composition is active so the keystroke confirms the composition instead of submitting.
 * `nativeEvent.isComposing` covers most browsers; `composing` bridges WebKit, which fires the
 * confirming Enter keydown *after* `compositionend`.
 */
export function shouldSubmitOnEnter(e: KeyboardEvent<HTMLTextAreaElement>, composing: boolean): boolean {
	if (e.key !== "Enter" || e.shiftKey) return false;
	return !(e.nativeEvent.isComposing || composing);
}

export function runComposerSendGate(
	online: boolean,
	phase: ConnectionPhase,
	keepDraft: () => void,
	send: () => void,
): boolean {
	if (!online || phase !== "live") {
		keepDraft();
		return false;
	}
	send();
	return true;
}

export function registerDraftFlush(
	sessionId: string | undefined,
	getDraft: () => string,
	saveDraft: (sessionId: string, draft: string) => void,
	win: EventTarget = window,
	doc: VisibilityTarget = document,
): () => void {
	if (sessionId === undefined) return () => {};
	const save = (): void => saveDraft(sessionId, getDraft());
	const onVisibilityChange = (): void => {
		if (doc.hidden) save();
	};
	win.addEventListener("pagehide", save);
	doc.addEventListener("visibilitychange", onVisibilityChange);
	return () => {
		win.removeEventListener("pagehide", save);
		doc.removeEventListener("visibilitychange", onVisibilityChange);
		save();
	};
}

/**
 * Tracks IME composition state via a ref the keydown handler reads synchronously. The
 * `compositionend` reset is deferred a tick because WebKit dispatches the confirming Enter
 * keydown after `compositionend`, when `nativeEvent.isComposing` is already `false`.
 */
function useCompositionGuard(): {
	composingRef: RefObject<boolean>;
	onCompositionStart(): void;
	onCompositionEnd(): void;
} {
	const composingRef = useRef(false);
	const onCompositionStart = useCallback((): void => {
		composingRef.current = true;
	}, []);
	const onCompositionEnd = useCallback((): void => {
		setTimeout(() => {
			composingRef.current = false;
		}, 0);
	}, []);
	return { composingRef, onCompositionStart, onCompositionEnd };
}

interface AskEditorProps {
	prefill: string | undefined;
	disabled: boolean;
	feedbackState: ActionFeedbackState;
	onSubmit(value: string): void;
}

/**
 * Editor ask input. Rendered with `key={reqId}` so a new request remounts it with a fresh
 * draft seeded from `prefill`, while re-sends of the same request never clobber a half-typed
 * draft. Submits verbatim — whitespace-only responses are intentional.
 */
function AskEditor({ prefill, disabled, feedbackState, onSubmit }: AskEditorProps): ReactNode {
	const [draft, setDraft] = useState(prefill ?? "");
	const taRef = useRef<HTMLTextAreaElement | null>(null);
	const { composingRef, onCompositionStart, onCompositionEnd } = useCompositionGuard();

	useLayoutEffect(() => {
		autosize(taRef.current, true);
	}, [draft]);

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (shouldSubmitOnEnter(e, composingRef.current)) {
			e.preventDefault();
			onSubmit(draft);
		}
	};

	return (
		<div className="sh-composer-inner">
			<textarea
				ref={taRef}
				className="sh-composer-input"
				value={draft}
				onChange={e => setDraft(e.target.value)}
				onKeyDown={onKeyDown}
				onCompositionStart={onCompositionStart}
				onCompositionEnd={onCompositionEnd}
				placeholder="type your response…"
				rows={1}
				disabled={disabled}
			/>
			<div className="sh-composer-actions">
				<button
					type="button"
					className="sh-btn sh-btn-primary"
					disabled={disabled}
					onClick={() => onSubmit(draft)}
					title="submit response"
				>
					<ActionFeedbackMark state={feedbackState} />
					<SendHorizontal size={12} /> <span className="sh-btn-label">Submit</span>
				</button>
			</div>
		</div>
	);
}

export interface AskFormProps {
	request: CollabUiRequest;
	/** A turn is running: Stop sits beside Cancel. */
	working: boolean;
	live: boolean;
	feedbackState?: ActionFeedbackState;
	feedbackError?: string | null;
	feedbackChoice?: string | null;
	onRespond(reqId: number, value?: string): void | Promise<void>;
	onAbort(): void;
}

/**
 * Host question (select, multi-marker select, or free text). Option buttons answer on one tap. The
 * question and options scroll inside `sh-ask-scroll`, so a long list never pushes Cancel and Stop
 * off a phone screen. Hook-free for selects: the editor variant mounts {@link AskEditor}.
 */
export function AskForm({
	request,
	working,
	live,
	feedbackState = "idle",
	feedbackError = null,
	feedbackChoice = null,
	onRespond,
	onAbort,
}: AskFormProps): ReactNode {
	const respond = (value?: string): void => {
		onRespond(request.reqId, value);
	};
	const stop = (): void => onAbort();
	return (
		<div className="sh-composer sh-composer-ask" role="group" aria-label="question from the agent">
			<div className="sh-ask-scroll">
				<div className="sh-ask-title">{visibleUiRequestTitle(request.title)}</div>
				{request.kind === "select" && request.helpText && <div className="sh-ask-help">{request.helpText}</div>}
				{request.kind === "select" ? (
					<div className="sh-ask-options">
						{request.options.map((option, index) => {
							const label = typeof option === "string" ? option : option.label;
							const checked = request.checkedIndices?.includes(index) ?? false;
							const recommended = request.initialIndex === index;
							return (
								<button
									key={`${request.reqId}-${index}-${label}`}
									type="button"
									className={`sh-ask-option${checked ? " sh-ask-option-checked" : ""}${recommended ? " sh-ask-option-recommended" : ""}`}
									data-recommended={recommended ? "true" : undefined}
									aria-label={recommended ? `${label}, recommended` : label}
									data-answer={label}
									disabled={feedbackState === "pending"}
									onClick={() => respond(label)}
								>
									<span className="sh-ask-option-marker">
										{request.selectionMarker === "checkbox" ? (checked ? "☑" : "☐") : checked ? "◉" : "○"}
									</span>
									<span className="sh-ask-option-copy">
										<span className="sh-ask-option-label">{label}</span>
										{typeof option !== "string" && option.description && (
											<span className="sh-ask-option-description">{option.description}</span>
										)}
									</span>
									<ActionFeedbackMark state={feedbackChoice === label ? feedbackState : "idle"} />
									{recommended && <span className="sh-ask-option-recommended-label">Recommended</span>}
								</button>
							);
						})}
					</div>
				) : (
					<AskEditor
						key={request.reqId}
						prefill={request.prefill}
						disabled={feedbackState === "pending"}
						feedbackState={feedbackState}
						onSubmit={respond}
					/>
				)}
			</div>
			<div className="sh-composer-actions sh-ask-actions">
				<button type="button" className="sh-btn" data-action="cancel" disabled={feedbackState === "pending"} onClick={() => respond()}>
					Cancel
				</button>
				{working && (
					<button
						type="button"
						className="sh-btn sh-btn-stop"
						data-action="stop"
						onClick={stop}
						disabled={!live || feedbackState === "pending"}
						title="stop the current turn"
						aria-label="stop the current turn"
					>
						<Square size={11} /> <span className="sh-btn-label">Stop</span>
						<ActionFeedbackMark state={feedbackChoice === "stop" ? feedbackState : "idle"} />
					</button>
				)}
			</div>
			<ActionFeedbackMessage
				state={feedbackState}
				error={feedbackError}
				pendingLabel={feedbackChoice === "stop" ? "Stopping turn…" : "Sending answer…"}
				successLabel={feedbackChoice === "stop" ? "Turn stopped" : "Answer sent"}
			/>
		</div>
	);
}

export interface ComposerNote {
	tone: "ok" | "error";
	text: string;
	equivalent?: string;
	actionId?: string;
	clearOnReconnect?: boolean;
}

export function clearRecoveredOfflineNote(
	note: ComposerNote | null,
	online: boolean,
	phase: ConnectionPhase,
): ComposerNote | null {
	return online && phase === "live" && note?.clearOnReconnect ? null : note;
}

/** The omp tokens the composer understands, shown while the draft is empty so they can be discovered. */
/** The composer hint keeps the file shortcut visible without turning the placeholder into a command reference. */
const PLACEHOLDER_LIVE = "Ask the agent to do something…  @file";
/** A one-row textarea narrower than this would wrap the full placeholder and cut its second line off. */
const PLACEHOLDER_FULL_MIN_WIDTH = 300;
const PLACEHOLDER_SHORT = "Ask the agent…  @file";

function hasDroppable(dt: DataTransfer): boolean {
	return Array.from(dt.types).some(type => type === "Files" || type === "text/uri-list");
}

/** Actions routed through the existing shell keymap, scoped to this active session. */
export interface TouchActionRowProps {
	working: boolean;
	paused?: boolean;
	promptActionsEnabled: boolean;
	planModeEnabled: boolean | null;
	phoneLayout: boolean;
	quickReplies: ReactNode;
	phoneSuggestions: readonly string[];
	phoneSuggestionStatus: QuickReplyStatus;
	prompts: readonly string[];
	promptUses: readonly PromptUse[];
	sessionId?: string;
	draft: string;
	lastLink: string | null;
	actionsOpen: boolean;
	onActionsOpenChange(open: boolean): void;
	onAction(action: DeckKeyAction): void;
	onSendPrompt(prompt: string): boolean;
	onStop(): void;
	onTogglePause?(): void;
	onAskAside(): void;
	api?: Pick<DeckApi, "listRecipes" | "startRecipe" | "readJournal" | "catalog" | "runCommand">;
	sessionOnLocalMachine?: boolean;
	overnightEnabled?: boolean;
}

interface TouchActionTileProps {
	action: string;
	label: string;
	icon: ReactNode;
	onClick(): void;
	disabled?: boolean;
	pressed?: boolean;
	title?: string;
}

function TouchActionTile({ action, label, icon, onClick, disabled = false, pressed, title }: TouchActionTileProps): ReactNode {
	return (
		<button type="button" className="cmp-action-tile" data-action={action} aria-pressed={pressed} disabled={disabled} title={title} onClick={onClick}>
			{icon}
			<span>{label}</span>
		</button>
	);
}

function phoneActionIcon(action: PhoneUsualAction): ReactNode {
	if (action.kind === "prompt") return <SendHorizontal size={17} aria-hidden="true" />;
	if (action.kind === "command") return <Terminal size={17} aria-hidden="true" />;
	if (action.kind === "recipe") return <BookmarkPlus size={17} aria-hidden="true" />;
	switch (action.id) {
		case "stop":
			return <Square size={17} aria-hidden="true" />;
		case "retry":
			return <RotateCcw size={17} aria-hidden="true" />;
		case "rewind":
			return <Undo2 size={17} aria-hidden="true" />;
		case "aside":
			return <MessageSquare size={17} aria-hidden="true" />;
		case "plan":
			return <ListChecks size={17} aria-hidden="true" />;
		case "model":
			return <Cpu size={17} aria-hidden="true" />;
		case "compact":
			return <ListChecks size={17} aria-hidden="true" />;
		case "last-link":
			return <ExternalLink size={17} aria-hidden="true" />;
		case "new-session":
			return <Plus size={17} aria-hidden="true" />;
		case "search":
			return <Search size={17} aria-hidden="true" />;
		case "pause":
			return action.label === "Resume" ? <Play size={17} aria-hidden="true" /> : <Pause size={17} aria-hidden="true" />;
	}
}


const ACTION_PANEL_EXIT_MS = 200;

export function TouchActionRow({
	working,
	paused = false,
	promptActionsEnabled,
	planModeEnabled,
	phoneLayout,
	quickReplies,
	phoneSuggestions,
	phoneSuggestionStatus,
	prompts,
	promptUses,
	draft,
	sessionId,
	lastLink,
	actionsOpen,
	onActionsOpenChange,
	onAction,
	onSendPrompt,
	onStop,
	onAskAside,
	onTogglePause,
	api,
	sessionOnLocalMachine,
	overnightEnabled = false,
}: TouchActionRowProps): ReactNode {
	const stopFeedback = useActionFeedback();
	const actionPanelId = useId();
	const [recipes, setRecipes] = useState<SessionRecipe[]>([]);
	const [recipesLoading, setRecipesLoading] = useState(false);
	const [recipesError, setRecipesError] = useState<string | null>(null);
	const [journalEvents, setJournalEvents] = useState<JournalEvent[]>([]);
	const [catalogCommands, setCatalogCommands] = useState<CatalogCommand[]>([]);
	const [personalizationLoading, setPersonalizationLoading] = useState(false);
	const [personalizationError, setPersonalizationError] = useState(false);
	const [savedReplies, setSavedReplies] = useState(readQuickReplies);
	const [recipeStarting, setRecipeStarting] = useState<string | null>(null);
	const [recipeStartError, setRecipeStartError] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const toggleRef = useRef<HTMLButtonElement | null>(null);
	const [actionsMounted, setActionsMounted] = useState(actionsOpen);
	const [actionsExiting, setActionsExiting] = useState(false);
	useEffect(() => {
		if (actionsOpen) {
			setActionsMounted(true);
			setActionsExiting(false);
			return;
		}
		if (!actionsMounted) return;
		if (motionLevel() === "off") {
			setActionsMounted(false);
			setActionsExiting(false);
			return;
		}
		setActionsExiting(true);
		const timer = window.setTimeout(() => {
			setActionsMounted(false);
			setActionsExiting(false);
		}, ACTION_PANEL_EXIT_MS);
		return () => window.clearTimeout(timer);
	}, [actionsOpen, actionsMounted]);
	const stop = (): void => {
		void stopFeedback.run(onStop).catch(() => {});
	};
	const runAction = (action: DeckKeyAction): void => {
		onActionsOpenChange(false);
		onAction(action);
	};
	const askAside = (): void => {
		onActionsOpenChange(false);
		onAskAside();
	};
	useEffect(() => {
		const refresh = (): void => setSavedReplies(readQuickReplies());
		window.addEventListener("storage", refresh);
		window.addEventListener(QUICK_REPLIES_CHANGED_EVENT, refresh);
		return () => {
			window.removeEventListener("storage", refresh);
			window.removeEventListener(QUICK_REPLIES_CHANGED_EVENT, refresh);
		};
	}, []);
	useEffect(() => {
		if (!phoneLayout || !actionsOpen || api === undefined) return;
		const controller = new AbortController();
		setRecipesLoading(true);
		setRecipesError(null);
		setPersonalizationLoading(true);
		setPersonalizationError(false);
		const loads: Promise<void>[] = [
			api.listRecipes(controller.signal).then(result => {
				if (!controller.signal.aborted) setRecipes(result.recipes);
			}).catch(() => {
				if (!controller.signal.aborted) setRecipesError("Session templates could not be loaded.");
			}),
			api.readJournal(500, controller.signal).then(result => {
				if (!controller.signal.aborted) setJournalEvents(result.events);
			}).catch(() => {
				if (!controller.signal.aborted) setPersonalizationError(true);
			}),
		];
		if (sessionId !== undefined) {
			loads.push(api.catalog(sessionId, controller.signal).then(result => {
				if (!controller.signal.aborted) setCatalogCommands(result.commands);
			}).catch(() => {
				if (!controller.signal.aborted) setPersonalizationError(true);
			}));
		}
		void Promise.all(loads).finally(() => {
			if (!controller.signal.aborted) {
				setRecipesLoading(false);
				setPersonalizationLoading(false);
			}
		});
		return () => controller.abort();
	}, [api, actionsOpen, phoneLayout, sessionId]);
	const actionPanel = useMemo(
		() =>
			buildPhoneActionPanel({
				events: journalEvents,
				prompts,
				promptUses,
				savedReplies,
				suggestions: phoneSuggestions,
				commands: catalogCommands,
				recipes,
				working,
				paused,
				now: Date.now(),
			}),
		[journalEvents, prompts, promptUses, savedReplies, phoneSuggestions, catalogCommands, recipes, working, paused],
	);
	const startRecipe = async (recipe: SessionRecipe): Promise<void> => {
		if (api === undefined || recipeStarting !== null) return;
		setRecipeStarting(recipe.id);
		setRecipeStartError(null);
		try {
			const session = await api.startRecipe(recipe.id, crypto.randomUUID());
			recordUsage({ feature: "phone-actions", action: "use", outcome: "ok", via: "direct", detail: `recipe:${recipe.id}` });
			onActionsOpenChange(false);
			const key = sessionKey(
				{ id: recipe.machineId, local: sessionOnLocalMachine ?? recipe.machineId === "local" },
				session.id,
			);
			window.location.hash = `session=${encodeURIComponent(key)}`;
		} catch (error) {
			setRecipeStartError(error instanceof Error ? error.message : "The session template could not be started.");
		} finally {
			setRecipeStarting(null);
		}
	};
	const runUsualAction = (action: PhoneUsualAction): void => {
		setActionError(null);
		if (action.kind === "prompt") {
			if (!promptActionsEnabled || !onSendPrompt(action.text)) return;
			onActionsOpenChange(false);
			return;
		}
		if (action.kind === "recipe") {
			void startRecipe(action.recipe);
			return;
		}
		if (action.kind === "command") {
			if (api === undefined || sessionId === undefined) return;
			void executeCommand(action.command, "", { api, sessionId, via: "composer" }).then(outcome => {
				if (outcome.kind === "error") {
					setActionError(outcome.message);
					return;
				}
				onActionsOpenChange(false);
			}).catch((error: unknown) => {
				setActionError(error instanceof Error ? error.message : "The command could not be run.");
			});
			return;
		}
		recordUsage({ feature: "phone-actions", action: "use", outcome: "ok", via: "direct", detail: `action:${action.id}` });
		switch (action.id) {
			case "stop":
				onActionsOpenChange(false);
				stop();
				return;
			case "retry":
				runAction("retry");
				return;
			case "pause":
				if (onTogglePause === undefined) return;
				onActionsOpenChange(false);
				onTogglePause();
				return;
			case "rewind":
				runAction("openRewind");
				return;
			case "aside":
				askAside();
				return;
			case "plan":
				runAction("togglePlan");
				return;
			case "model":
				runAction("selectModel");
				return;
			case "compact":
				onActionsOpenChange(false);
				openPanel({ panel: "status" });
				return;
			case "last-link":
				if (lastLink === null) return;
				onActionsOpenChange(false);
				openExternalLink(lastLink);
				return;
			case "new-session":
				onActionsOpenChange(false);
				openPanel({ panel: "sessions" });
				return;
			case "search":
				runAction("searchHistory");
				return;
		}
	};
	if (!phoneLayout) {
		return (
			<div className="cmp-touch-actions" role="toolbar" aria-label="Session actions">
				{(working || stopFeedback.state === "success") && (
					<button
						type="button"
						className="cmp-touch-action"
						data-action="stop"
						disabled={stopFeedback.state === "pending"}
						onClick={stop}
					>
						<ActionFeedbackMark state={stopFeedback.state} />
						{stopFeedback.state === "pending" ? "Stopping…" : stopFeedback.state === "success" ? "Stopped" : "Stop"}
					</button>
				)}
				<button type="button" className="cmp-touch-action" data-action="pause" aria-pressed={paused} onClick={onTogglePause}>
					{paused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}
					{paused ? "Resume" : "Pause"}
				</button>
				{stopFeedback.state === "failure" && (
					<ActionFeedbackMessage state={stopFeedback.state} error={stopFeedback.error} />
				)}
				<button type="button" className="cmp-touch-action" data-action="retry" onClick={() => onAction("retry")}>Retry</button>
				<button type="button" className="cmp-touch-action" data-action="rewind" onClick={() => onAction("openRewind")}>Rewind</button>
				<button type="button" className="cmp-touch-action" data-action="aside" onClick={onAskAside}>Ask aside</button>
				<button
					type="button"
					className="cmp-touch-action"
					data-action="plan"
					aria-pressed={planModeEnabled ?? false}
					onClick={() => onAction("togglePlan")}
				>
					Plan mode{planModeEnabled ? " · On" : ""}
				</button>
				<button type="button" className="cmp-touch-action" data-action="model" onClick={() => onAction("selectModel")}>Model</button>
			</div>
		);
	}

	return (
		<div
			className="cmp-phone-actions"
			onKeyDown={event => {
				// Escape closes the panel and returns focus to its toggle.
				if (event.key !== "Escape" || !actionsOpen) return;
				event.preventDefault();
				onActionsOpenChange(false);
				toggleRef.current?.focus();
			}}
		>
			<div className="cmp-phone-action-bar" role="toolbar" aria-label="Session shortcuts">
				{working || stopFeedback.state === "pending" ? (
					// While a turn runs, Stop takes Retry's place: one tap, as before the panel existed.
					<button
						type="button"
						className="cmp-touch-shortcut"
						data-action="stop"
						disabled={stopFeedback.state === "pending"}
						onClick={stop}
					>
						<ActionFeedbackMark state={stopFeedback.state} />
						<Square size={16} aria-hidden="true" />
						<span>{stopFeedback.state === "pending" ? "Stopping…" : "Stop"}</span>
					</button>
				) : (
					<button type="button" className="cmp-touch-shortcut" data-action="retry" onClick={() => runAction("retry")}>
						<RotateCcw size={16} aria-hidden="true" />
						<span>Retry</span>
					</button>
				)}
				<button type="button" className="cmp-touch-shortcut" data-action="rewind" onClick={() => runAction("openRewind")}>
					<Undo2 size={16} aria-hidden="true" />
					<span>Rewind</span>
				</button>
				<button
					ref={toggleRef}
					type="button"
					className="cmp-action-toggle"
					aria-expanded={actionsOpen}
					aria-controls={actionPanelId}
					onClick={() => onActionsOpenChange(!actionsOpen)}
				>
					<Grid2X2 size={16} aria-hidden="true" />
					<span>Actions</span>
				</button>
			</div>
			{(actionsOpen || actionsMounted) && (
				<div
					id={actionPanelId}
					className="cmp-touch-action-panel"
					data-motion={motionLevel()}
					data-exiting={actionsExiting ? "true" : undefined}
					role="region"
					aria-label="Actions"
					aria-hidden={actionsExiting}
					inert={actionsExiting}
				>
					<section className="cmp-action-section" aria-labelledby={`${actionPanelId}-suggestions`}>
						<h3 id={`${actionPanelId}-suggestions`}>Suggestions</h3>
						{phoneSuggestionStatus === "loading" && <p className="cmp-action-status" role="status">Generating suggestions…</p>}
						{phoneSuggestionStatus === "error" && <p className="cmp-action-status" role="alert">Suggestions unavailable.</p>}
						{phoneSuggestionStatus === "idle" && <p className="cmp-action-status">Suggestions appear after an agent answer.</p>}
						{phoneSuggestionStatus === "ready" && phoneSuggestions.length === 0 && <p className="cmp-action-status">No suggestions for this answer.</p>}
						{phoneSuggestionStatus === "ready" && phoneSuggestions.length > 0 && (
							<div className="cmp-action-quick-replies">{quickReplies}</div>
						)}
					</section>
					<section className="cmp-action-section" aria-labelledby={`${actionPanelId}-usual-actions`}>
						<h3 id={`${actionPanelId}-usual-actions`}>Usual actions</h3>
						{(personalizationLoading || recipesLoading) && <p className="cmp-action-status" role="status">Loading recent actions…</p>}
						{personalizationError && <p className="cmp-action-status">Some recent activity is unavailable; showing defaults.</p>}
						{stopFeedback.state === "failure" && <ActionFeedbackMessage state={stopFeedback.state} error={stopFeedback.error} />}
						<div className="cmp-action-grid">
							{actionPanel.usualActions.map(action => (
								<TouchActionTile
									key={action.id}
									action={action.id}
									label={action.label}
									icon={phoneActionIcon(action)}
									title={action.title}
									pressed={
										action.kind !== "action"
											? undefined
											: action.id === "plan"
												? planModeEnabled ?? false
												: action.id === "pause"
													? paused
													: undefined
									}
									disabled={
										(action.kind === "prompt" && !promptActionsEnabled) ||
										(action.kind === "recipe" && recipeStarting !== null) ||
										(action.kind === "action" && action.id === "last-link" && lastLink === null)
									}
									onClick={() => runUsualAction(action)}
								/>
							))}
							{overnightEnabled && (
								<TouchActionTile
									action="overnight"
									label="Overnight run"
									icon={<Moon size={17} aria-hidden="true" />}
									disabled={api === undefined || sessionId === undefined}
									title="Start an overnight run for this session"
									onClick={() => {
										onActionsOpenChange(false);
										openPanel({ panel: "overnight", task: draft });
									}}
								/>
							)}
						</div>
						{actionError && <p className="cmp-btw-error" role="alert">{actionError}</p>}
						{recipesError && <p className="cmp-btw-error" role="alert">{recipesError}</p>}
						{recipeStartError && <p className="cmp-btw-error" role="alert">{recipeStartError}</p>}
					</section>
				</div>
			)}
		</div>
	);
}

/** Memoized on its snapshot fields, so streaming frames that leave them untouched skip it. */
export const Composer = memo(function Composer({
	client,
	phase,
	readOnly,
	uiRequest,
	working,
	queuedMessageCount,
	api,
	sessionId,
	sessionOnLocalMachine = false,
	active = true,
	touchLayout = false,
	paused = false,
	onTogglePause,
	phoneLayout = false,
	quickReplies = null,
	phoneSuggestions = EMPTY_PHONE_SUGGESTIONS,
	phoneSuggestionStatus = "idle",
	lastLink = null,
	actionsOpen: actionsOpenProp,
	onActionsOpenChange,
	planModeEnabled = null,
	emptySession = false,
	overnightEnabled = false,
}: ComposerProps): ReactNode {
	const [text, setText] = useState(() => (sessionId === undefined ? "" : promptHistory.loadDraft(sessionId)));
	const [caret, setCaret] = useState(0);
	const [images, setImages] = useState<ImageAttachment[]>([]);
	const [note, setNote] = useState<ComposerNote | null>(null);
	const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine);
	const [dropActive, setDropActive] = useState(false);
	const [uploads, setUploads] = useState<UploadChip[]>([]);
	const uploadControllers = useRef(new Map<number, AbortController>());
	const nextUploadId = useRef(0);
	const filePickerRef = useRef<HTMLInputElement | null>(null);
	const [keybindingsOpen, setKeybindingsOpen] = useState(false);
	const [localActionsOpen, setLocalActionsOpen] = useState(false);
	const [promptHistoryVersion, setPromptHistoryVersion] = useState(0);
	useEffect(() => {
		const refresh = (): void => setPromptHistoryVersion(version => version + 1);
		window.addEventListener(PROMPT_HISTORY_CHANGED_EVENT, refresh);
		return () => window.removeEventListener(PROMPT_HISTORY_CHANGED_EVENT, refresh);
	}, []);
	const actionsOpen = actionsOpenProp ?? localActionsOpen;
	const updateActionsOpen = onActionsOpenChange ?? setLocalActionsOpen;
	const [rewindOpen, setRewindOpen] = useState(false);
	const [btwOpen, setBtwOpen] = useState(false);
	const [btwQuestion, setBtwQuestion] = useState("");
	// One side-question topic: earlier turns stay visible and every follow-up continues the same omp btw record.
	const [btwTurns, setBtwTurns] = useState<readonly BtwTurn[]>([]);
	const [btwPendingQuestion, setBtwPendingQuestion] = useState<string | null>(null);
	const btwRecordRef = useRef<string | undefined>(undefined);
	const [btwLoading, setBtwLoading] = useState(false);
	const [btwError, setBtwError] = useState<string | null>(null);
	const taRef = useRef<HTMLTextAreaElement | null>(null);
	const composerRef = useRef<HTMLDivElement | null>(null);
	const pendingCaret = useRef<number | null>(null);
	const nextImageId = useRef(0);
	const sendPendingRef = useRef(false);
	const sendFeedback = useActionFeedback();
	const stopFeedback = useActionFeedback();
	const askFeedback = useActionFeedback();
	const [askFeedbackChoice, setAskFeedbackChoice] = useState<string | null>(null);
	const sendFeedbackTimer = useRef<number | null>(null);
	useEffect(
		() => () => {
			if (sendFeedbackTimer.current !== null) window.clearTimeout(sendFeedbackTimer.current);
		},
		[],
	);
	const textRef = useRef(text);
	textRef.current = text;
	const [narrowInput, setNarrowInput] = useState(false);
	useEffect(() => {
		const input = taRef.current;
		if (!input || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => setNarrowInput(input.clientWidth < PLACEHOLDER_FULL_MIN_WIDTH));
		observer.observe(input);
		return () => observer.disconnect();
	}, []);
	const imagesRef = useRef(images);
	imagesRef.current = images;
	const { composingRef, onCompositionStart, onCompositionEnd } = useCompositionGuard();
	const listId = useId();
	const historyCursor = useRef(new HistoryCursor());
	/** Ctrl+R state: what was searched for, the entry index shown, and its text (typing ends the search). */
	const historySearch = useRef<{ query: string; index: number; shown: string } | null>(null);

	// Draft: restored when this session's composer mounts (a pane reused for another session), saved shortly after
	// each edit and when the composer goes away, so it survives switching panes.
	useEffect(() => {
		if (sessionId === undefined || textRef.current !== "") return;
		const draft = promptHistory.loadDraft(sessionId);
		if (draft !== "") setText(draft);
	}, [sessionId]);
	useEffect(() => {
		if (sessionId === undefined) return;
		const timer = setTimeout(() => promptHistory.saveDraft(sessionId, text), DRAFT_SAVE_MS);
		return () => clearTimeout(timer);
	}, [sessionId, text]);
	useEffect(
		() =>
			registerDraftFlush(sessionId, () => textRef.current, (id, draft) => promptHistory.saveDraft(id, draft)),
		[sessionId],
	);
	useEffect(() => {
		const sync = (): void => setOnline(navigator.onLine);
		window.addEventListener("online", sync);
		window.addEventListener("offline", sync);
		sync();
		return () => {
			window.removeEventListener("online", sync);
			window.removeEventListener("offline", sync);
		};
	}, []);
	useEffect(() => {
		setNote(current => clearRecoveredOfflineNote(current, online, phase));
	}, [online, phase]);
	useEffect(() => {
		setUploads([]);
	}, [api, sessionId]);
	useEffect(
		() => () => {
			for (const controller of uploadControllers.current.values()) controller.abort();
			uploadControllers.current.clear();
		},
		[api, sessionId],
	);

	const live = phase === "live";
	const canPrompt = live && !readOnly;
	const busy = working;
	const actionPrompts = useMemo(
		() => (sessionId === undefined ? [] : promptHistory.entries(sessionId)),
		[sessionId, promptHistoryVersion],
	);
	const actionPromptUses = useMemo(
		() => (sessionId === undefined ? [] : promptHistory.promptUses(sessionId)),
		[sessionId, promptHistoryVersion],
	);
	const uploadsPending = uploads.some(upload => upload.error === undefined);
	const canSend = !readOnly && !uploadsPending && (text.trim().length > 0 || images.length > 0);
	const imagesOk = supportsPromptImages(client);
	const assist = useAssist({ api, sessionId, text, caret, enabled: canPrompt && !uiRequest, overnightEnabled });

	useLayoutEffect(() => {
		const el = taRef.current;
		if (text === "" && images.length === 0) sendPendingRef.current = false;
		if (!autosize(el, text === "")) return;
		const timer = setTimeout(() => autosize(el, true), SHRINK_DELAY_MS);
		return () => clearTimeout(timer);
	}, [text, images.length, uiRequest?.reqId]);

	// Move the caret after a programmatic edit (suggestion accepted, drop inserted).
	useLayoutEffect(() => {
		const target = pendingCaret.current;
		const el = taRef.current;
		if (target === null || !el) return;
		pendingCaret.current = null;
		el.focus({ preventScroll: true });
		el.setSelectionRange(target, target);
		setCaret(target);
	}, [text]);

	useEffect(
		() => () => {
			for (const image of imagesRef.current) URL.revokeObjectURL(image.previewUrl);
		},
		[],
	);

	const edit = useCallback((next: Insertion): void => {
		textRef.current = next.text;
		pendingCaret.current = next.caret;
		setText(next.text);
		setCaret(next.caret);
	}, []);
	// Desktop only: the phone's Actions panel carries suggestions, and a touch keyboard has no Tab.
	const starterOffered = emptySession && canPrompt && !phoneLayout && !touchLayout;
	const [starterIndex, setStarterIndex] = useState(0);
	const starterPlaceholder = starterOffered && !narrowInput ? `Try “${STARTER_PROMPTS[starterIndex]}” — press Tab` : null;

	const insertMentionPaths = useCallback((paths: readonly string[]): void => {
		if (paths.length === 0) return;
		const current = textRef.current;
		const pending = pendingCaret.current;
		const from = pending ?? taRef.current?.selectionStart ?? current.length;
		const to = pending ?? taRef.current?.selectionEnd ?? current.length;
		const cwd = client.getSnapshot().state?.cwd;
		edit(insertAtSelection(current, from, to, paths.map(path => formatDroppedPath(path, cwd)).join(" ")));
	}, [client, edit]);


	const clearImages = useCallback((): void => {
		for (const image of imagesRef.current) URL.revokeObjectURL(image.previewUrl);
		setImages([]);
	}, []);
	const askBtw = useCallback(async (question: string): Promise<void> => {
		const clean = question.trim();
		if (clean === "") {
			setBtwError("Enter a question first.");
			return;
		}
		if (api === undefined || sessionId === undefined) {
			setBtwError("Side questions need a connected session.");
			return;
		}
		setBtwQuestion("");
		setBtwPendingQuestion(clean);
		setBtwError(null);
		setBtwLoading(true);
		try {
			const recordId = btwRecordRef.current;
			const result = await api.sessionOpV3(sessionId, recordId === undefined ? { op: "btw", question: clean } : { op: "btw", question: clean, recordId });
			if (!("answer" in result)) throw new Error("The session did not return a side answer.");
			btwRecordRef.current = result.recordId ?? recordId;
			setBtwTurns(turns => [...turns, { question: clean, answer: result.answer }]);
		} catch (cause) {
			setBtwQuestion(clean);
			setBtwError(cause instanceof Error ? cause.message : "Could not answer the side question.");
		} finally {
			setBtwPendingQuestion(null);
			setBtwLoading(false);
		}
	}, [api, sessionId]);

	/** Back to a fresh topic: the next question starts a new omp btw record. */
	const newBtwTopic = useCallback((): void => {
		btwRecordRef.current = undefined;
		setBtwTurns([]);
		setBtwQuestion("");
		setBtwError(null);
	}, []);
	// A composer reused for another session must not continue the old session's topic.
	useEffect(() => newBtwTopic(), [sessionId, newBtwTopic]);

	const runShell = useCallback(async (mode: ShellInputMode): Promise<boolean> => {
		if (api === undefined || sessionId === undefined) {
			setNote({ tone: "error", text: "Shell input needs a connected session." });
			return false;
		}
		if (images.length > 0) {
			setNote({ tone: "error", text: "Remove attached images before running shell input." });
			return false;
		}
		try {
			const result = await api.sessionOpV3(sessionId, {
				op: "shell",
				kind: mode.kind,
				code: mode.code,
				excludeFromContext: mode.excludeFromContext,
			});
			if (!("output" in result)) throw new Error("The session did not return shell output.");
			publishTranscriptOutput({
				id: crypto.randomUUID(),
				sessionId,
				kind: mode.kind,
				excludeFromContext: mode.excludeFromContext,
				command: mode.code,
				output: result.output,
				...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
				at: Date.now(),
			});
			setText("");
			setCaret(0);
			setNote(null);
			historyCursor.current.reset();
			return true;
		} catch (cause) {
			setNote({ tone: "error", text: cause instanceof Error ? cause.message : "Could not run shell input." });
			return false;
		}
	}, [api, sessionId, images.length]);

	const handleKeyAction = useCallback((action: DeckKeyAction): void => {
		if (action === "abortSession") {
			client.sendAbort();
			return;
		}
		if (action === "copyPrompt") {
			void copyText(textRef.current).then(ok => setNote({ tone: ok ? "ok" : "error", text: ok ? "Prompt copied." : "Could not copy the prompt." }));
			return;
		}
		if (action === "pauseGoal") {
			if (api === undefined || sessionId === undefined) {
				setNote({ tone: "error", text: "Pausing a goal needs a connected session." });
				return;
			}
			void api.sessionOp(sessionId, { op: "goal", action: "pause" }).then(
				() => setNote({ tone: "ok", text: "Goal paused." }),
				cause => setNote({ tone: "error", text: cause instanceof Error ? cause.message : "Could not pause the goal." }),
			);
			return;
		}
		if (action === "openRewind") {
			if (api === undefined || sessionId === undefined) {
				setNote({ tone: "error", text: "Rewind needs a connected session." });
				return;
			}
			setRewindOpen(true);
			return;
		}
		if (action === "searchHistory") {
			// omp's Ctrl+R: the newest earlier prompt containing what is typed; pressing again goes further back.
			if (sessionId === undefined) return;
			const entries = promptHistory.entries(sessionId);
			const search = historySearch.current;
			const query = search !== null && textRef.current === search.shown ? search.query : textRef.current;
			const from = search !== null && query === search.query ? search.index - 1 : entries.length - 1;
			for (let index = from; index >= 0; index--) {
				const entry = entries[index]!;
				if (entry.toLowerCase().includes(query.trim().toLowerCase())) {
					historySearch.current = { query, index, shown: entry };
					edit({ text: entry, caret: entry.length });
					setNote({ tone: "ok", text: `History: match ${entries.length - index} of ${entries.length}` });
					return;
				}
			}
			historySearch.current = null;
			setNote({ tone: "error", text: query.trim() === "" ? "No earlier prompts." : `No earlier prompt contains "${query.trim()}".` });
			return;
		}
		dispatchKeymapAction(action, sessionId);
	}, [api, client, sessionId, edit]);

	const keymap = useKeymap({
		api,
		enabled: canPrompt && active && !uiRequest,
		composerRef: taRef,
		getComposerText: () => textRef.current,
		onAction: handleKeyAction,
	});

	useEffect(() => {
		if (!active) return;
		const onKeybindings = (): void => setKeybindingsOpen(true);
		window.addEventListener(OPEN_KEYBINDINGS_EVENT, onKeybindings);
		return () => window.removeEventListener(OPEN_KEYBINDINGS_EVENT, onKeybindings);
	}, [active]);

	useEffect(() => {
		if (!active || !canPrompt) return;
		const onBtw = (): void => {
			setBtwError(null);
			setBtwOpen(true);
		};
		window.addEventListener(OPEN_BTW_EVENT, onBtw);
		return () => window.removeEventListener(OPEN_BTW_EVENT, onBtw);
	}, [active, canPrompt]);

	const removeImage = useCallback((id: number): void => {
		setImages(prev => {
			const hit = prev.find(image => image.id === id);
			if (hit) URL.revokeObjectURL(hit.previewUrl);
			return prev.filter(image => image.id !== id);
		});
	}, []);
	const chooseGitHubReference = useCallback((kind: "issue" | "pr"): void => {
		const reference = findGitHubReference(text, taRef.current?.selectionStart ?? caret);
		if (reference === null) return;
		const replacement = githubReferenceUri(kind, reference.number);
		const nextText = text.slice(0, reference.start) + replacement + text.slice(reference.end);
		edit({ text: nextText, caret: reference.start + replacement.length });
		setNote({ tone: "ok", text: `Inserted ${replacement}.` });
	}, [text, caret, edit]);


	// Other panels put text here (a skill, a `^model`, a command that needs arguments).
	useEffect(() => {
		if (!canPrompt || !active) return;
		const onInsert = (event: Event): void => {
			const detail = (event as CustomEvent<ComposerInsertDetail>).detail;
			if (!detail || typeof detail.text !== "string" || detail.text === "") return;
			const current = textRef.current;
			if (detail.replace) {
				edit({ text: detail.text, caret: detail.text.length });
				return;
			}
			if (detail.atStart) {
				const next = detail.text + current.replace(/^\s*\/\S*\s*/, "");
				edit({ text: next, caret: detail.text.length });
				return;
			}
			const el = taRef.current;
			edit(insertAtSelection(current, el?.selectionStart ?? current.length, el?.selectionEnd ?? current.length, detail.text.trim()));
		};
		window.addEventListener(COMPOSER_INSERT_EVENT, onInsert);
		return () => window.removeEventListener(COMPOSER_INSERT_EVENT, onInsert);
	}, [canPrompt, active, edit]);

	const sendAsPrompt = useCallback((trimmed: string): boolean => {
		if (!canPrompt || !active || uiRequest !== null || !sendFeedback.begin()) return false;
		if (sendFeedbackTimer.current !== null) {
			window.clearTimeout(sendFeedbackTimer.current);
			sendFeedbackTimer.current = null;
		}
		sendPendingRef.current = true;
		try {
			if (busy) queueTracker(client).record(trimmed || "[image]");
			submitPrompt(client, trimmed, images);
			if (sessionId !== undefined) promptHistory.push(sessionId, trimmed);
			historyCursor.current.reset();
			setNote(null);
			clearImages();
			sendFeedbackTimer.current = window.setTimeout(() => {
				sendFeedbackTimer.current = null;
				textRef.current = "";
				setText("");
				setCaret(0);
				sendFeedback.succeed();
			}, SEND_FEEDBACK_PENDING_MS);
			return true;
		} catch (error) {
			sendPendingRef.current = false;
			sendFeedback.fail(error);
			setNote({ tone: "error", text: error instanceof Error ? error.message : "Could not send the prompt." });
			return false;
		}
	}, [active, canPrompt, uiRequest, busy, client, images, sessionId, clearImages, sendFeedback]);

	/** Clears the command text (`rest` stays) and says what happened, for a picked or a typed-out command. */
	const reportCommandOutcome = useCallback((command: CatalogCommand, outcome: CommandOutcome, rest: string, caretAt = rest.length): void => {
		const equivalent = commandEquivalent(command);
		const actionId = `command:${command.name}`;
		if (outcome.kind === "ran") {
			edit({ text: rest, caret: caretAt });
			setNote({ tone: "ok", text: `Ran ${outcome.text}`, equivalent, actionId });
		} else if (outcome.kind === "panel") {
			edit({ text: rest, caret: caretAt });
			setNote({ tone: "ok", text: `Opened ${outcome.panel}`, equivalent, actionId });
		} else if (outcome.kind === "terminal") {
			edit({ text: rest, caret: caretAt });
			setNote({ tone: "ok", text: "Terminal only: run it in omp.", equivalent: outcome.equivalent, actionId });
		} else if (outcome.kind === "error") {
			setNote({ tone: "error", text: outcome.message });
		}
	}, [edit]);

	const send = useCallback((): void => {
		const trimmed = text.trim();
		if (sendPendingRef.current || (!trimmed && images.length === 0) || readOnly) return;
		runComposerSendGate(
			online,
			phase,
			() => {
				if (sessionId !== undefined) promptHistory.saveDraft(sessionId, textRef.current);
				setNote({ tone: "error", text: "Not sent: offline. It stays here; send again when back online.", clearOnReconnect: true });
			},
			() => {
				updateActionsOpen(false);
				const shell = parseShellInput(trimmed);
				if (shell !== null) {
					sendPendingRef.current = true;
					void runShell(shell).then(sent => {
						if (!sent) sendPendingRef.current = false;
					});
					return;
				}
				const btw = parseBtwCommand(trimmed);
				if (btw !== null) {
					if (images.length > 0) {
						setNote({ tone: "error", text: "Remove attached images before asking a side question." });
						return;
					}
					if (api === undefined || sessionId === undefined) {
						setNote({ tone: "error", text: "Side questions need a connected session." });
						return;
					}
					sendPendingRef.current = true;
					setText("");
					setCaret(0);
					setNote(null);
					setBtwOpen(true);
					if (btw.question !== "") void askBtw(btw.question);
					else setBtwQuestion("");
					return;
				}
				if (findGitHubReference(text, taRef.current?.selectionStart ?? caret) !== null) {
					setNote({ tone: "error", text: "Choose Issue or Pull request to resolve this #number before sending." });
					return;
				}
				// `/name args` typed out and sent (Send button, or Enter after the suggestion list closed) runs the command
				// like picking it from the list; text that names no known command still goes to the agent as a prompt.
				const slash = SLASH_COMMAND_RE.exec(trimmed);
				if (slash !== null && (images.length === 0 || slash[1] === "queue") && api !== undefined && sessionId !== undefined) {
					sendPendingRef.current = true;
					const name = slash[1]!;
					void catalogCache
						.load(api, sessionId, false)
						.then(
							catalog => withOvernightCommand(catalog.commands, overnightEnabled).find(command => command.name === name || command.aliases?.includes(name)),
							() => undefined,
						)
						.then(command => {
							if (command?.name === "queue" && images.length > 0) {
								const queuedImages = images.map(({ data, mimeType }) => ({ type: "image" as const, data, mimeType }));
								void api.sessionOpV3(sessionId, { op: "queue", text: slash[2] ?? "", images: queuedImages })
									.then(result => {
										if (!("queued" in result)) {
											setNote({ tone: "error", text: "The session did not confirm the queued follow-up." });
											return;
										}
										if (textRef.current.trim() === trimmed) {
											setText("");
											setCaret(0);
										}
										if (imagesRef.current === images) clearImages();
										setNote({ tone: "ok", text: `Queued ${result.queued} follow-up${result.queued === 1 ? "" : "s"}.` });
									}, error => {
										setNote({ tone: "error", text: error instanceof Error ? error.message : "Could not queue the follow-up." });
									})
									.finally(() => {
										sendPendingRef.current = false;
									});
								return;
							}
							if (command === undefined) {
								sendPendingRef.current = false;
								// Edited while the command list loaded: keep the new text instead of sending (and clearing) the old.
								if (textRef.current.trim() !== trimmed) return;
								sendAsPrompt(trimmed);
								return;
							}
							// Still pending until the outcome: a second Enter must not run the command twice.
							void executeCommand(command, slash[2] ?? "", {
								api,
								sessionId,
								via: "composer",
								insert: detail => edit({ text: detail.text, caret: detail.text.length }),
							}).then(outcome => {
								sendPendingRef.current = false;
								reportCommandOutcome(command, outcome, "");
							});
						});
					return;
				}
				sendAsPrompt(trimmed);
			},
		);
	}, [api, askBtw, caret, online, phase, readOnly, runShell, sessionId, text, images, sendAsPrompt, reportCommandOutcome, edit, updateActionsOpen]);

	const attachFiles = useCallback(
		async (files: File[], source: "paste" | "drop" | "picker"): Promise<void> => {
			if (!imagesOk) {
				setNote({ tone: "error", text: "This build cannot send images to the host yet." });
				return;
			}
			const added: ImageAttachment[] = [];
			const problems: string[] = [];
			for (const file of files) {
				const name = file.name || "image";
				const reason = attachRejection(file, imagesRef.current.length + added.length);
				if (reason !== null) {
					problems.push(rejectionMessage(name, reason));
					continue;
				}
				try {
					const data = await fileToBase64(file);
					added.push({ id: ++nextImageId.current, name, mimeType: file.type, data, previewUrl: URL.createObjectURL(file) });
				} catch {
					problems.push(`${name}: could not be read`);
				}
			}
			if (added.length > 0) {
				setImages(prev => [...prev, ...added]);
				recordUsage({ feature: "5.5.image", action: `attach:${source}`, outcome: "ok", via: "composer", detail: String(added.length) });
			}
			if (problems.length > 0) setNote({ tone: "error", text: problems.join(" · ") });
		},
		[imagesOk],
	);
	const queueUploads = useCallback((files: readonly File[]): void => {
		for (const file of files) {
			const id = ++nextUploadId.current;
			const name = file.name || "file";
			if (file.size > MAX_UPLOAD_BYTES) {
				setUploads(current => [...current, { id, name, size: file.size, loaded: 0, error: "Files must be 50 MiB or smaller." }]);
				continue;
			}
			if (api === undefined || sessionId === undefined) {
				setUploads(current => [...current, { id, name, size: file.size, loaded: 0, error: "A connected session is required to upload files." }]);
				continue;
			}
			const controller = new AbortController();
			uploadControllers.current.set(id, controller);
			setUploads(current => [...current, { id, name, size: file.size, loaded: 0 }]);
			void api
				.uploadFile(sessionId, file, {
					signal: controller.signal,
					onProgress: loaded => {
						if (!uploadControllers.current.has(id)) return;
						setUploads(current => current.map(upload => upload.id === id ? { ...upload, loaded } : upload));
					},
				})
				.then(upload => {
					if (!uploadControllers.current.delete(id)) return;
					setUploads(current => current.filter(item => item.id !== id));
					insertMentionPaths([upload.path]);
					notifyToast(sessionId, `${name} uploaded.`);
				})
				.catch(error => {
					if (!uploadControllers.current.delete(id)) return;
					setUploads(current => current.map(item => item.id === id
						? { ...item, error: error instanceof Error ? error.message : "Upload failed" }
						: item));
				});
		}
	}, [api, insertMentionPaths, sessionId]);
	const cancelUpload = useCallback((id: number): void => {
		uploadControllers.current.get(id)?.abort();
		uploadControllers.current.delete(id);
		setUploads(current => current.filter(upload => upload.id !== id));
	}, []);


	const processFiles = useCallback((files: readonly File[], source: "paste" | "picker"): void => {
		const toAttach: File[] = [];
		const toUpload: File[] = [];
		for (const file of files) {
			if (isPromptImage(file) && imagesOk) toAttach.push(file);
			else toUpload.push(file);
		}
		if (toAttach.length > 0) void attachFiles(toAttach, source);
		if (toUpload.length > 0) queueUploads(toUpload);
	}, [attachFiles, imagesOk, queueUploads]);


	const pick = useCallback(
		(index: number): void => {
			const row = assist.rows[index];
			const trigger = assist.trigger;
			if (!row || row.disabled || !trigger) return;
			const payload = row.payload;
			if (payload.kind === "file") {
				const dir = payload.item.kind === "dir";
				recordUsage({ feature: "5.1.mention", action: dir ? "accept-dir" : "accept-file", outcome: "ok", via: "suggestion" });
				edit(applyMention(text, trigger, formatFileMention(payload.item.path, dir), !dir));
			} else if (payload.kind === "model") {
				recordUsage({ feature: "5.3.model-mention", action: "accept", outcome: "ok", via: "suggestion", detail: payload.model.provider });
				edit(applyMention(text, trigger, formatModelMention(payload.model.selector), true));
			} else {
				const rest = text.slice(0, trigger.start) + text.slice(trigger.end);
				void executeCommand(payload.command, "", {
					api,
					sessionId,
					via: "composer",
					insert: detail => edit({ text: detail.text, caret: detail.text.length }),
				}).then(outcome => reportCommandOutcome(payload.command, outcome, rest, trigger.start));
			}
		},
		[assist.rows, assist.trigger, text, edit, api, sessionId, reportCommandOutcome],
	);

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		const composing = composingRef.current || e.nativeEvent.isComposing;
		// Tab in an empty session's empty input takes the suggested starter; Tab again offers the next one.
		if (e.key === "Tab" && !e.shiftKey && !composing && !assist.open && starterOffered && (text === "" || STARTER_PROMPTS.some(prompt => prompt === text))) {
			e.preventDefault();
			const next = text === "" ? starterIndex : (starterIndex + 1) % STARTER_PROMPTS.length;
			setStarterIndex(next);
			const prompt = STARTER_PROMPTS[next]!;
			edit({ text: prompt, caret: prompt.length });
			return;
		}
		if (assist.open && !composing) {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				assist.move(1);
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				assist.move(-1);
				return;
			}
			if ((e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) && assist.rows.length > 0) {
				e.preventDefault();
				pick(assist.active);
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				assist.dismiss();
				return;
			}
		}
		if (sessionId !== undefined && !composing && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
			if (!e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
				const el = e.currentTarget;
				const shown = historyCursor.current.step(
					e.key === "ArrowUp" ? "up" : "down",
					text,
					promptHistory.entries(sessionId),
					caretLines(text, el.selectionStart),
				);
				if (shown !== null) {
					e.preventDefault();
					edit({ text: shown, caret: shown.length });
					return;
				}
			}
		}
		if (shouldSubmitOnEnter(e, composingRef.current)) {
			e.preventDefault();
			send();
		}
	};

	const syncCaret = (): void => setCaret(taRef.current?.selectionStart ?? 0);

	const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
		const files = Array.from(e.clipboardData.files);
		if (files.length === 0) return;
		if (e.clipboardData.getData("text/plain") === "") e.preventDefault();
		processFiles(files, "paste");
	};

	const onDragOver = (e: DragEvent<HTMLDivElement>): void => {
		if (!canPrompt || !hasDroppable(e.dataTransfer)) return;
		e.preventDefault();
		e.dataTransfer.dropEffect = "copy";
		setDropActive(true);
	};

	const onDragLeave = (e: DragEvent<HTMLDivElement>): void => {
		if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropActive(false);
	};

	const onDrop = (e: DragEvent<HTMLDivElement>): void => {
		if (!canPrompt) return;
		e.preventDefault();
		handleDrop(e.dataTransfer);
	};

	const handleDrop = (dt: DataTransfer): void => {
		setDropActive(false);
		const fileList = Array.from(dt.files);
		const plan = planDrop({
			uriList: dt.getData("text/uri-list"),
			text: dt.getData("text/plain"),
			files: fileList.map(({ name, type }) => ({ name, type })),
		});
		const mentions = sessionOnLocalMachine ? [...plan.mentionPaths] : [];
		const toAttach: File[] = [];
		const toUpload: File[] = [];
		for (const image of plan.images) {
			const file = fileList[image.index];
			if (!file) continue;
			if (imagesOk) toAttach.push(file);
			else if (sessionOnLocalMachine && image.path !== undefined) mentions.push(image.path);
			else toUpload.push(file);
		}
		for (const dropped of plan.nonImages) {
			const file = fileList[dropped.index];
			if (!file || (sessionOnLocalMachine && dropped.path !== undefined)) continue;
			toUpload.push(file);
		}
		if (mentions.length > 0) {
			const cwd = client.getSnapshot().state?.cwd;
			const inside = mentions.filter(path => relativeToCwd(path, cwd ?? "") !== null).length;
			const where = inside === mentions.length ? "inside" : inside === 0 ? "outside" : "mixed";
			recordUsage({ feature: "5.6.drop", action: "mention", outcome: "ok", via: "composer", detail: where });
			insertMentionPaths(mentions);
		}
		if (toAttach.length > 0) void attachFiles(toAttach, "drop");
		if (toUpload.length > 0) queueUploads(toUpload);
		const strandedPaths = sessionOnLocalMachine ? [] : plan.unmatchedPaths;
		if (strandedPaths.length > 0) {
			recordUsage({ feature: "5.6.drop", action: "path-hidden", outcome: "error", via: "composer", detail: String(strandedPaths.length) });
			setNote({
				tone: "error",
				text: "The dropped path has no file data to send to the computer running this session. Drop the file again to attach it.",
			});
		}
		if (mentions.length === 0 && toAttach.length === 0 && toUpload.length === 0 && strandedPaths.length === 0) {
			const dropped = dt.getData("text/plain");
			if (dropped !== "") {
				const current = textRef.current;
				const pending = pendingCaret.current;
				const from = pending ?? taRef.current?.selectionStart ?? current.length;
				const to = pending ?? taRef.current?.selectionEnd ?? current.length;
				edit(insertAtSelection(current, from, to, dropped.trim()));
			}
		}
	};
	const handleDropRef = useRef(handleDrop);
	handleDropRef.current = handleDrop;
	// Files dropped anywhere on this session's pane (transcript included), not only on the composer box, are taken by
	// the composer. Drops on the composer itself keep its own handlers.
	useEffect(() => {
		// Every pane takes drops on itself, focused or not: each composer finds its own pane.
		if (!canPrompt) return;
		const pane = composerRef.current?.closest(".sh-panel");
		if (!(pane instanceof HTMLElement)) return;
		const outsideComposer = (event: Event): boolean => !composerRef.current?.contains(event.target as Node | null);
		const onPaneDragOver = (event: globalThis.DragEvent): void => {
			if (!event.dataTransfer || !hasDroppable(event.dataTransfer) || !outsideComposer(event)) return;
			event.preventDefault();
			event.dataTransfer.dropEffect = "copy";
			setDropActive(true);
		};
		const onPaneDragLeave = (event: globalThis.DragEvent): void => {
			if (!pane.contains(event.relatedTarget as Node | null)) setDropActive(false);
		};
		const onPaneDrop = (event: globalThis.DragEvent): void => {
			if (!event.dataTransfer || !outsideComposer(event)) return;
			event.preventDefault();
			handleDropRef.current(event.dataTransfer);
		};
		pane.addEventListener("dragover", onPaneDragOver);
		pane.addEventListener("dragleave", onPaneDragLeave);
		pane.addEventListener("drop", onPaneDrop);
		return () => {
			pane.removeEventListener("dragover", onPaneDragOver);
			pane.removeEventListener("dragleave", onPaneDragLeave);
			pane.removeEventListener("drop", onPaneDrop);
		};
	}, [canPrompt]);
	const shellMode = detectShellMode(text);
	const githubReference = findGitHubReference(text, caret);

	const respondToAsk = (reqId: number, value?: string): void => {
		if (askFeedback.state === "pending") return;
		setAskFeedbackChoice(value ?? "cancel");
		void askFeedback.run(() => client.sendUiResponse(reqId, value)).catch(() => {});
	};
	const stopAsk = (): void => {
		if (askFeedback.state === "pending") return;
		setAskFeedbackChoice("stop");
		void askFeedback.run(() => client.sendAbort()).catch(() => {});
	};

	if (uiRequest && canPrompt) {
		return (
			<AskForm
				request={uiRequest}
				working={busy}
				live={live}
				feedbackState={askFeedback.state}
				feedbackError={askFeedback.error}
				feedbackChoice={askFeedbackChoice}
				onRespond={respondToAsk}
				onAbort={stopAsk}
			/>
		);
	}

	// Keep modal sheets inside the panel, not the positioned composer.
	const sheetHost = composerRef.current?.closest(".sh-panel") ?? null;
	// The touch action row carries Stop; wherever it is not shown (link-joined session, unfocused pane, an open
	// question) the composer keeps its own Stop button.
	const touchActionRow = touchLayout && canPrompt && active && sessionId !== undefined && uiRequest === null;
	return (
		<div ref={composerRef} className="sh-composer cmp-composer" data-send-feedback={sendFeedback.state} data-tour="main-pane">
			{assist.open && assist.trigger && (
				<ComposerSuggest
					listId={listId}
					title={assist.title}
					rows={assist.rows}
					active={assist.active}
					error={assist.error}
					onPick={pick}
					onHover={assist.setActive}
				/>
			)}
			{note && (
				<div className="cmp-note" data-tone={note.tone} role={note.tone === "error" ? "alert" : "status"}>
					<span className="cmp-note-text">{note.text}</span>
					{note.equivalent && <OmpEquivalent text={note.equivalent} actionId={note.actionId ?? "command"} via="composer" />}
					<button type="button" className="cmp-note-close" onClick={() => setNote(null)} aria-label="dismiss message">
						<X size={12} />
					</button>
				</div>
			)}
			{touchActionRow && (
				<TouchActionRow
					working={busy}
					draft={text}
					promptActionsEnabled={canPrompt && active && uiRequest === null}
					planModeEnabled={planModeEnabled}
					phoneLayout={phoneLayout}
					quickReplies={quickReplies}
					phoneSuggestions={phoneSuggestions}
					phoneSuggestionStatus={phoneSuggestionStatus}
					prompts={actionPrompts}
					promptUses={actionPromptUses}
					sessionId={sessionId}
					lastLink={lastLink}
					actionsOpen={actionsOpen}
					api={api}
					overnightEnabled={overnightEnabled}
					onActionsOpenChange={updateActionsOpen}
					onAction={handleKeyAction}
					onSendPrompt={sendAsPrompt}
					onStop={() => client.sendAbort()}
					onAskAside={() => {
						setBtwError(null);
						setBtwOpen(true);
					}}
					paused={paused}
					onTogglePause={onTogglePause}
				/>
			)}
			<div
				className="sh-composer-inner cmp-inner"
				data-drop={dropActive ? "true" : "false"}
				onDragOver={onDragOver}
				onDragLeave={onDragLeave}
				onDrop={onDrop}
			>
				<div className="cmp-field">
					<QueueChips client={client} count={queuedMessageCount} readOnly={readOnly} api={api} sessionId={sessionId} />
					{images.length > 0 && <AttachmentChips images={images} onRemove={removeImage} />}
					{uploads.length > 0 && <UploadChips uploads={uploads} onCancel={cancelUpload} />}
					{/* An empty session suggests a starter in the placeholder (Tab takes it), so nothing takes room above the input. */}
					{active && canPrompt && !emptySession && <TipCard tips={COMPOSER_TIPS} />}
					{shellMode !== null && (
						<div className="cmp-mode-hint" role="status">
							{shellMode.kind === "bash" ? "Bash" : "Python"} input
							{shellMode.excludeFromContext ? " · excluded from context" : " · runs on send"}
						</div>
					)}
					{githubReference !== null && (
						<div className="cmp-github-suggest" role="listbox" aria-label={`Resolve GitHub reference ${githubReference.number}`}>
							<span># {githubReference.number}</span>
							<button type="button" role="option" onMouseDown={event => event.preventDefault()} onClick={() => chooseGitHubReference("issue")}>
								Issue · insert issue://{githubReference.number}
							</button>
							<button type="button" role="option" onMouseDown={event => event.preventDefault()} onClick={() => chooseGitHubReference("pr")}>
								Pull request · insert pr://{githubReference.number}
							</button>
						</div>
					)}
					<textarea
						ref={taRef}
						className="sh-composer-input"
						value={text}
						onChange={e => {
							textRef.current = e.target.value;
							setText(e.target.value);
							setCaret(e.target.selectionStart);
							if (note) setNote(null);
						}}
						onKeyDown={onKeyDown}
						onKeyUp={syncCaret}
						onClick={syncCaret}
						onSelect={syncCaret}
						onPaste={onPaste}
						onCompositionStart={onCompositionStart}
						onCompositionEnd={onCompositionEnd}
						aria-controls={assist.open ? listId : undefined}
						aria-activedescendant={assist.open && assist.rows.length > 0 ? suggestOptionId(listId, assist.active) : undefined}
						aria-autocomplete="list"
						placeholder={
							readOnly
								? "Read-only session — watching only"
								: live
									? starterPlaceholder ?? (api && sessionId
										? narrowInput
											? PLACEHOLDER_SHORT
											: PLACEHOLDER_LIVE
										: "Ask the agent to do something…")
									: phase === "reconnecting"
										? "Reconnecting… you can keep typing"
										: "Waiting for the session…"
						}
						disabled={readOnly}
						readOnly={readOnly || sendFeedback.state === "pending"}
						rows={1}
						spellCheck={false}
						onFocus={phoneLayout ? () => updateActionsOpen(false) : undefined}
					/>
				</div>
				<div className="sh-composer-actions">
					<input
						ref={filePickerRef}
						type="file"
						multiple
						hidden
						onChange={event => {
							const files = Array.from(event.currentTarget.files ?? []);
							if (files.length > 0) processFiles(files, "picker");
							event.currentTarget.value = "";
						}}
					/>
					<button
						type="button"
						className="sh-btn sh-btn-icon"
						onClick={() => filePickerRef.current?.click()}
						disabled={readOnly}
						title="Attach files"
						aria-label="attach files"
					>
						<Paperclip size={14} />
					</button>
					{api !== undefined && (
						<button
							type="button"
							className="sh-btn sh-btn-icon"
							onClick={() => setKeybindingsOpen(true)}
							title="Keyboard shortcuts"
							aria-label="keyboard shortcuts"
						>
							<span aria-hidden="true">?</span>
						</button>
					)}
					{api && sessionId && (
						<button
							type="button"
							className="sh-btn sh-btn-icon"
							onClick={() => openPanel({ panel: "catalog" })}
							title="What omp can do (Cmd+K for commands)"
							aria-label="what omp can do"
						>
							<Compass size={14} />
						</button>
					)}
					{(busy || stopFeedback.state === "success") && !readOnly && !touchActionRow && (
						<button
							type="button"
							className="sh-btn sh-btn-stop"
							onClick={() => void stopFeedback.run(() => client.sendAbort()).catch(() => {})}
							disabled={!live || stopFeedback.state === "pending"}
							title="stop the current turn"
							aria-label="stop the current turn"
						>
							<ActionFeedbackMark state={stopFeedback.state} />
							<Square size={11} /> <span className="sh-btn-label">{stopFeedback.state === "pending" ? "Stopping…" : stopFeedback.state === "success" ? "Stopped" : "Stop"}</span>
						</button>
					)}
					{stopFeedback.state === "failure" && !touchActionRow && (
						<ActionFeedbackMessage state={stopFeedback.state} error={stopFeedback.error} />
					)}
					<button
						type="button"
						className="sh-btn sh-btn-primary"
						onClick={send}
						disabled={!canSend}
						title="send (Enter)"
						aria-label="send"
					>
						<ActionFeedbackMark state={sendFeedback.state} />
						<SendHorizontal size={12} /> <span className="sh-btn-label">Send</span>
					</button>
				</div>
			</div>
			{sheetHost !== null && api !== undefined && keybindingsOpen && createPortal(
				<KeybindingsSheet keybindings={keymap.keybindings} error={keymap.error} onClose={() => setKeybindingsOpen(false)} />,
				sheetHost,
			)}
			{sheetHost !== null && api !== undefined && sessionId !== undefined && createPortal(
				<RewindSheet
					api={api}
					sessionId={sessionId}
					open={rewindOpen}
					onClose={() => setRewindOpen(false)}
					onRewind={outcome => {
						if (outcome.kind === "agent") {
							client.rewoundAfter(outcome.keptThrough);
							return;
						}
						edit({ text: outcome.text, caret: outcome.text.length });
						client.rewoundTo(outcome.entryId);
					}}
				/>,
				sheetHost,
			)}
			{btwOpen && (
				<BtwPanel
					question={btwQuestion}
					turns={btwTurns}
					pendingQuestion={btwPendingQuestion}
					loading={btwLoading}
					error={btwError}
					onQuestionChange={setBtwQuestion}
					onSubmit={() => void askBtw(btwQuestion)}
					onNewTopic={newBtwTopic}
					onInsert={answer => {
						const el = taRef.current;
						const from = el?.selectionStart ?? text.length;
						const to = el?.selectionEnd ?? text.length;
						edit(insertAtSelection(text, from, to, answer));
						setBtwOpen(false);
					}}
					onClose={() => setBtwOpen(false)}
				/>
			)}
		</div>
	);
});
