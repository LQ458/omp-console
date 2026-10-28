import type { LoopModeStatus, SessionOp, SessionOpV3, VibeModeStatus } from "@omp-console/protocol";
import { Check, ChevronDown, ListChecks, Repeat2, SlidersHorizontal, Sparkles, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DeckApi } from "../../lib/api";
import { OPEN_PANEL_EVENT, type OpenPanelDetail } from "../../lib/palette";
import { runSessionOp, sessionOpError } from "../../lib/session-ops";
import { recordUsage } from "../../lib/journal";
import { OmpEquivalent } from "../catalog/OmpEquivalent";
import { OverlayLayer } from "../spawn/OmpLine";
import { ActionFeedbackMark, ActionFeedbackMessage } from "../shell/ActionFeedback";
import { useActionFeedback } from "../../lib/action-feedback";

export type ApprovalMode = Extract<SessionOp, { op: "approval-mode" }>['mode'];

const APPROVAL_MODES: ReadonlyArray<{ value: ApprovalMode; label: string }> = [
	{ value: "always-ask", label: "Always ask" },
	{ value: "always-ask-cached", label: "Always ask (cached)" },
	{ value: "write", label: "Write" },
	{ value: "yolo", label: "No approval prompts" },
];

const PLAN_MODE_HELP = "Plan mode (/plan): the agent explores and writes a plan first; it edits files only after you approve the plan.";
const APPROVAL_MODE_HELP =
	"Approval mode: Always ask auto-approves read-only tools and asks before writes or execution; Always ask (cached) can remember file grants; Write auto-approves read/write tools and asks before execution; No approval prompts lets every tool action run without asking.";

export interface SessionOpsMenuProps {
	api: DeckApi;
	sessionId: string;
	planModeEnabled: boolean | null;
	loopMode?: LoopModeStatus;
	vibeMode?: VibeModeStatus;
	focused?: boolean;
	/** The host's approval mode (reported in collab state); wins over what this menu last set. */
	hostApprovalMode?: string;
	onSetPlanMode(enabled: boolean, via: "direct" | "suggestion"): Promise<void>;
}

export function SessionOpsMenu({
	api,
	sessionId,
	planModeEnabled,
	loopMode,
	vibeMode,
	focused = false,
	hostApprovalMode,
	onSetPlanMode,
}: SessionOpsMenuProps): ReactNode {
	const rootRef = useRef<HTMLDivElement | null>(null);
	const menuRef = useRef<HTMLDivElement | null>(null);
	const triggerRef = useRef<HTMLButtonElement | null>(null);
	const [menuPosition, setMenuPosition] = useState({ left: 12, top: 12 });
	const [open, setOpen] = useState(false);
	const [localApprovalMode, setApprovalMode] = useState<ApprovalMode | null>(null);
	const approvalMode = APPROVAL_MODES.find(item => item.value === hostApprovalMode)?.value ?? localApprovalMode;
	const [confirmYolo, setConfirmYolo] = useState(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const actionFeedback = useActionFeedback();
	const [feedbackTarget, setFeedbackTarget] = useState<"approval" | "plan" | "mode" | null>(null);
	const [loopModeState, setLoopModeState] = useState(loopMode);
	const [vibeModeState, setVibeModeState] = useState(vibeMode);

	useEffect(() => setLoopModeState(loopMode), [loopMode]);
	useEffect(() => setVibeModeState(vibeMode), [vibeMode]);

	const setMode = async (mode: ApprovalMode): Promise<void> => {
		if (!actionFeedback.begin()) return;
		setFeedbackTarget("approval");
		setPending(true);
		setError(null);
		try {
			await runSessionOp(api, sessionId, { op: "approval-mode", mode }, {
				feature: "1.7.approval-mode",
				action: `set:${mode}`,
				screen: "header",
			});
			setApprovalMode(mode);
			setConfirmYolo(false);
			actionFeedback.succeed();
		} catch (cause) {
			setError(sessionOpError(cause));
			actionFeedback.fail(cause);
		} finally {
			setPending(false);
		}
	};

	const togglePlan = async (): Promise<void> => {
		if (!actionFeedback.begin()) return;
		setFeedbackTarget("plan");
		setPending(true);
		setError(null);
		try {
			await onSetPlanMode(planModeEnabled !== true, "direct");
			actionFeedback.succeed();
		} catch (cause) {
			setError(sessionOpError(cause));
			actionFeedback.fail(cause);
		} finally {
			setPending(false);
		}
	};
	const runModeOperation = useCallback(async (op: Extract<SessionOpV3, { op: "loop-mode" | "vibe-mode" }>): Promise<void> => {
		if (!actionFeedback.begin()) return;
		setFeedbackTarget("mode");
		setPending(true);
		setError(null);
		try {
			const result = await api.sessionOpV3(sessionId, op);
			if ("loopMode" in result) setLoopModeState(result.loopMode);
			if ("vibeMode" in result) setVibeModeState(result.vibeMode);
			actionFeedback.succeed();
		} catch (cause) {
			setError(sessionOpError(cause));
			actionFeedback.fail(cause);
		} finally {
			setPending(false);
		}
	}, [actionFeedback, api, sessionId]);

	useEffect(() => {
		if (!focused) return;
		const onPanel = (event: Event): void => {
			const detail = (event as CustomEvent<OpenPanelDetail>).detail;
			if (detail?.panel !== "session-modes") return;
			setOpen(true);
			if (detail.command === "loop") {
				void runModeOperation(detail.args
					? { op: "loop-mode", action: "toggle", args: detail.args }
					: { op: "loop-mode", action: "toggle" });
			} else if (detail.command === "vibe") {
				void runModeOperation(detail.args
					? { op: "vibe-mode", action: "toggle", args: detail.args }
					: { op: "vibe-mode", action: "toggle" });
			}
		};
		window.addEventListener(OPEN_PANEL_EVENT, onPanel);
		return () => window.removeEventListener(OPEN_PANEL_EVENT, onPanel);
	}, [focused, runModeOperation]);

	// Phone keeps its in-place sheet; desktop overflow popovers use a viewport layer to escape pane clipping.
	const portalMenu = Boolean(rootRef.current?.closest(".sh-header-overflow-menu"));
	useLayoutEffect(() => {
		if (!open || !portalMenu) return;
		const positionMenu = (): void => {
			const trigger = triggerRef.current;
			const menu = menuRef.current;
			if (!trigger || !menu) return;
			const anchor = trigger.getBoundingClientRect();
			const bounds = menu.getBoundingClientRect();
			const gutter = 12;
			const left = Math.max(gutter, Math.min(anchor.right - bounds.width, window.innerWidth - gutter - bounds.width));
			const below = anchor.bottom + 8;
			const top = below + bounds.height <= window.innerHeight - gutter ? below : Math.max(gutter, anchor.top - gutter - bounds.height);
			setMenuPosition(previous => previous.left === left && previous.top === top ? previous : { left, top });
		};
		positionMenu();
		window.addEventListener("resize", positionMenu);
		window.addEventListener("scroll", positionMenu, true);
		return () => {
			window.removeEventListener("resize", positionMenu);
			window.removeEventListener("scroll", positionMenu, true);
		};
	}, [open, portalMenu]);

	useEffect(() => {
		if (!open) return;
		const onPointer = (event: PointerEvent): void => {
			if (!(event.target instanceof Node)) return;
			if (rootRef.current?.contains(event.target) || menuRef.current?.contains(event.target)) return;
			setOpen(false);
		};
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("pointerdown", onPointer);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", onPointer);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);
	const menuContent = (
		<div
			ref={menuRef}
			className={portalMenu ? "so-menu so-menu-portal" : "so-menu"}
			style={portalMenu ? { left: menuPosition.left, top: menuPosition.top } : undefined}
			role="group"
			aria-label="session operations"
		>
			<div className="so-menu-head">
				<h3>Session</h3>
				<button type="button" className="dk-tap so-menu-close" onClick={() => setOpen(false)} aria-label="close session operations" title="close">
					<X size={16} />
				</button>
			</div>
			<OmpEquivalent text="app.plan.toggle" actionId="1.6.plan-mode" />
			<p className="dk-hint">Approval mode: {approvalMode ? APPROVAL_MODES.find(item => item.value === approvalMode)?.label : "not reported"}</p>
			<label className="so-field">
				<span>Approval mode <ActionFeedbackMark state={feedbackTarget === "approval" ? actionFeedback.state : "idle"} /></span>
				<select
					value={approvalMode ?? ""}
					disabled={pending}
					onChange={event => {
						const value = APPROVAL_MODES.find(mode => mode.value === event.currentTarget.value)?.value;
						if (value === "yolo") setConfirmYolo(true);
						else if (value) void setMode(value);
					}}
				>
					<option value="">Choose a mode…</option>
					{APPROVAL_MODES.map(mode => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
				</select>
			</label>
			<p className="dk-hint">
				Always ask prompts before writes and execution. Cached mode can remember file grants; Write allows read and write tools before asking for execution; No approval prompts lets every tool action run without asking.
			</p>
			<OmpEquivalent text={`tools.approvalMode${approvalMode ? ` = "${approvalMode}"` : ""}`} actionId="1.7.approval-mode" />
			{confirmYolo && (
				<div className="so-warning" role="alert">
					<p>No approval prompts removes per-action approval questions. Confirm only if you want omp to run tool actions without asking.</p>
					<div className="so-action-row">
						<button type="button" className="dk-wide-btn" disabled={pending} onClick={() => setConfirmYolo(false)}>Cancel</button>
						<button type="button" className="dk-wide-btn so-danger" disabled={pending} onClick={() => void setMode("yolo")}>
							<Check size={14} /> Enable no approval prompts
						</button>
					</div>
				</div>
			)}
			{planModeEnabled === null && <p className="dk-hint">Plan mode state is not reported by the host; this badge reflects changes made here only.</p>}
			<ActionFeedbackMessage
				state={actionFeedback.state}
				error={error}
				pendingLabel={feedbackTarget === "mode" ? "Updating session mode…" : feedbackTarget === "plan" ? "Updating plan mode…" : "Updating approval mode…"}
				successLabel={feedbackTarget === "mode" ? "Session mode updated" : feedbackTarget === "plan" ? "Plan mode updated" : "Approval mode updated"}
			/>
		</div>
	);
	const renderMenu = open ? (portalMenu ? <OverlayLayer>{menuContent}</OverlayLayer> : menuContent) : null;

	return (
		<div className="so-header-controls" ref={rootRef}>
			{loopModeState?.active && (
				<div
					className="so-plan-active so-loop-chip"
					title={[loopModeState.condition, loopModeState.message].filter(Boolean).join(" · ") || "Loop mode is active"}
					aria-label={`Loop mode active, ${loopModeState.waitingForPrompt ? "waiting for a prompt" : `iteration ${loopModeState.iteration}, limit ${loopModeState.limit ?? "unlimited"}`}`}
				>
					<Repeat2 size={14} aria-hidden />
					<span>Loop {loopModeState.waitingForPrompt ? "waiting" : `${loopModeState.iteration}/${loopModeState.limit ?? "∞"}`}</span>
					<button type="button" className="so-loop-stop" disabled={pending} onClick={() => void runModeOperation({ op: "loop-mode", action: "disable" })} aria-label="Stop loop" title="Stop loop">
						<X size={12} aria-hidden />
					</button>
				</div>
			)}
			<button
				type="button"
				className={vibeModeState?.active ? "so-plan-active" : "so-plan-button"}
				aria-label={`Explore mode ${vibeModeState?.active ? "on" : "off"}; click to ${vibeModeState?.active ? "turn off" : "turn on"}`}
				aria-pressed={vibeModeState?.active ?? false}
				title="Explore mode limits which tools the agent can use and stops its child sessions when it ends."
				disabled={pending}
				onClick={() => void runModeOperation({ op: "vibe-mode", action: "toggle" })}
			>
				<Sparkles size={14} aria-hidden />
				<span>Explore</span>
				<span className="so-plan-state">{vibeModeState?.active ? "On" : "Off"}</span>
			</button>
			<button
				type="button"
				className={planModeEnabled ? "sh-chip so-plan-active" : "sh-chip so-plan-button"}
				title={planModeEnabled === null ? `${PLAN_MODE_HELP} The host state is unknown; clicking turns it on.` : `${PLAN_MODE_HELP} Currently ${planModeEnabled ? "on" : "off"}.`}
				aria-label={planModeEnabled === null ? "Plan mode, state unknown; turn on" : `Plan mode, ${planModeEnabled ? "on" : "off"}; click to ${planModeEnabled ? "turn off" : "turn on"}`}
				aria-pressed={planModeEnabled === null ? undefined : planModeEnabled}
				disabled={pending}
				onClick={() => void togglePlan()}
			>
				<ListChecks size={14} aria-hidden />
				<ActionFeedbackMark state={feedbackTarget === "plan" ? actionFeedback.state : "idle"} />
				<span>Plan mode</span>
				<span className="so-plan-state">{planModeEnabled === null ? "Unknown" : planModeEnabled ? "On" : "Off"}</span>
			</button>
			<button
				type="button"
				ref={triggerRef}
				className="dk-tap so-menu-trigger"
				onClick={() => {
					const next = !open;
					setOpen(next);
					if (next) recordUsage({ feature: "1.7.approval-mode", action: "open-menu", outcome: "ok", via: "direct", screen: "header", sessionId });
				}}
				aria-expanded={open}
				aria-label="Approval mode controls"
				title={APPROVAL_MODE_HELP}
			>
				<SlidersHorizontal size={15} />
				<span>Approval mode</span>
				<ChevronDown size={12} />
			</button>
			{renderMenu}
		</div>
	);
}
