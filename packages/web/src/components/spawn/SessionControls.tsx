import type { ListModelsResponse } from "@omp-console/protocol";
import type { SessionState } from "@oh-my-pi/pi-wire";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { describeControlError } from "../../lib/agent-api";
import type { ModelPickItem } from "../../lib/agent-models";
import type { DeckApi } from "../../lib/api";
import { recordUsage } from "../../lib/journal";
import { OPEN_SESSION_CONTROLS_EVENT } from "../../lib/key-actions";
import {
	modelEquivalent,
	reflectHost,
	resolveCurrentSelector,
	SessionControlStore,
	shortModelName,
	THINKING_LEVELS,
	type ThinkingLevel,
	thinkingEquivalent,
} from "../../lib/session-model";
import { ModelPicker } from "../agents/ModelPicker";
import { Sheet } from "../shell/Sheet";
import { ActionFeedbackMark } from "../shell/ActionFeedback";
import { OmpLine, OverlayLayer } from "./OmpLine";
import "./spawn.css";

export interface SessionControlsProps {
	api: DeckApi;
	sessionId: string;
	/** The session's root agent: the one whose model and thinking these controls change. */
	agentId: string;
	state: SessionState | null;
	/** Phone layout: one icon button that opens a sheet instead of the two chips. */
	phone: boolean;
}

/** The catalog changes when credentials or omp config change, rarely within minutes. */
const MODEL_LIST_TTL_MS = 5 * 60_000;
const MODEL_LIST_TIMEOUT_MS = 20_000;
const modelLists = new WeakMap<DeckApi, { at: number; list: Promise<ListModelsResponse> }>();

/** One model-list request per daemon per few minutes: every session's controls share it. */
function cachedModelList(api: DeckApi): Promise<ListModelsResponse> {
	const cached = modelLists.get(api);
	if (cached && Date.now() - cached.at < MODEL_LIST_TTL_MS) return cached.list;
	const list = api.listModels(AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS));
	modelLists.set(api, { at: Date.now(), list });
	list.catch(() => {
		if (modelLists.get(api)?.list === list) modelLists.delete(api);
	});
	return list;
}

/** Header chips for model and thinking that open the controls; the host's `state` frame stays the source of truth. */
export function SessionControls({ api, sessionId, agentId, state, phone }: SessionControlsProps): ReactNode {
	const store = useMemo(
		() => new SessionControlStore({ api, sessionId, agentId, record: recordUsage }),
		[api, sessionId, agentId],
	);
	const snap = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
	const [successVisible, setSuccessVisible] = useState(false);
	useEffect(() => {
		if (!snap.note) {
			setSuccessVisible(false);
			return;
		}
		setSuccessVisible(true);
		const timer = window.setTimeout(() => setSuccessVisible(false), 700);
		return () => window.clearTimeout(timer);
	}, [snap.note]);
	const [open, setOpen] = useState(false);
	// Alt+M / Alt+P (omp's model pickers) open this popover for its session.
	useEffect(() => {
		const onOpen = (event: Event): void => {
			if ((event as CustomEvent<{ sessionId?: string }>).detail?.sessionId === sessionId) setOpen(true);
		};
		window.addEventListener(OPEN_SESSION_CONTROLS_EVENT, onOpen);
		return () => window.removeEventListener(OPEN_SESSION_CONTROLS_EVENT, onOpen);
	}, [sessionId]);
	const [models, setModels] = useState<ListModelsResponse | null>(null);
	const [modelsError, setModelsError] = useState<string | null>(null);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const hostModel = state?.model?.id;
	const hostThinking = state?.thinkingLevel;
	const modelValue = reflectHost(hostModel, snap.model, "model");
	const thinkingValue = reflectHost(hostThinking, snap.thinking, "text");
	const selector = resolveCurrentSelector(models, modelValue);
	const modelLabel =
		modelValue === hostModel && state?.model
			? state.model.name
			: modelValue === undefined
				? undefined
				: (models?.models.find(m => m.selector === modelValue)?.label ?? shortModelName(modelValue));

	const loadModels = useCallback(async () => {
		setModelsError(null);
		try {
			const list = await cachedModelList(api);
			if (mounted.current) setModels(list);
		} catch (err) {
			if (!mounted.current) return;
			const timedOut = err instanceof DOMException && err.name === "TimeoutError";
			setModelsError(
				timedOut
					? `The model list did not arrive within ${MODEL_LIST_TIMEOUT_MS / 1000} s. Check the connection and retry.`
					: describeControlError(err, "load"),
			);
		}
	}, [api]);
	// Every way of opening (chip, phone menu, Alt+M/Alt+P, the composer's model chip) needs the list: an open sheet
	// with no request in flight would say "Loading models…" forever.
	useEffect(() => {
		if (open && models === null && modelsError === null) void loadModels();
	}, [open, models, modelsError, loadModels]);

	const toggle = (): void => {
		const next = !open;
		setOpen(next);
		if (next) {
			store.clearError();
			recordUsage({ feature: "1.9.controls", action: "open", outcome: "ok", via: "direct", screen: "header", sessionId });
		}
	};
	const close = useCallback(() => setOpen(false), []);

	const pickModel = (item: ModelPickItem): void => {
		void store.setModel(item.selector, hostModel, models);
	};
	const pickThinking = (level: ThinkingLevel): void => {
		void store.setThinking(level, hostThinking);
	};

	const body = (
		<ControlsBody
			models={models}
			modelsError={modelsError}
			onRetryModels={() => void loadModels()}
			modelLabel={modelLabel}
			selector={selector}
			thinking={thinkingValue}
			busy={snap.busy}
			pending={snap.pending}
			error={snap.error}
			note={snap.note}
			successVisible={successVisible}
			onPickModel={pickModel}
			onPickThinking={pickThinking}
			onCopy={what => recordUsage({ feature: "0.2.equivalent", action: `copy-${what}`, outcome: "ok", via: "direct", screen: "header", sessionId })}
		/>
	);

	if (phone) {
		return (
			<>
				<button
					type="button"
					className={open ? "dk-tap dk-tap-on" : "dk-tap"}
					onClick={toggle}
					aria-haspopup="dialog"
					aria-expanded={open}
					aria-label={`model and thinking${modelLabel ? `: ${modelLabel}` : ""}`}
					title="model and thinking"
				>
					<SlidersHorizontal size={20} />
				</button>
				{open && (
					<OverlayLayer>
						<Sheet title="Model and thinking" onClose={close}>
							{body}
						</Sheet>
					</OverlayLayer>
				)}
			</>
		);
	}

	return (
		<>
			<button
				type="button"
				className="sh-chip sc-chip"
				onClick={toggle}
				aria-haspopup="dialog"
				aria-expanded={open}
				title="change model (this session only)"
				disabled={state?.model === undefined && snap.model === null}
			>
				<span className="sc-chip-text">{modelLabel ?? "model"}</span>
				<ChevronDown size={11} aria-hidden />
			</button>
			<button
				type="button"
				className="sh-chip sc-chip"
				onClick={toggle}
				aria-haspopup="dialog"
				aria-expanded={open}
				title="change thinking level (this session only)"
			>
				<span className="sc-chip-text">{thinkingValue ?? "thinking"}</span>
				<ChevronDown size={11} aria-hidden />
			</button>
			{open && (
				<OverlayLayer>
					<Popover onClose={close}>{body}</Popover>
				</OverlayLayer>
			)}
		</>
	);
}

/** Anchored under the header, closed by Escape or a click outside. */
function Popover({ onClose, children }: { onClose(): void; children: ReactNode }): ReactNode {
	const ref = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		ref.current?.focus({ preventScroll: true });
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);
	return (
		<>
			<div className="sc-scrim" onClick={onClose} />
			<div ref={ref} tabIndex={-1} className="sc-pop" role="dialog" aria-label="Model and thinking">
				{children}
			</div>
		</>
	);
}

interface ControlsBodyProps {
	models: ListModelsResponse | null;
	modelsError: string | null;
	onRetryModels(): void;
	modelLabel: string | undefined;
	selector: string | undefined;
	thinking: string | undefined;
	busy: "model" | "thinking" | null;
	pending: string | null;
	error: { control: "model" | "thinking"; message: string } | null;
	successVisible?: boolean;
	note: string | null;
	onPickModel(item: ModelPickItem): void;
	onPickThinking(level: ThinkingLevel): void;
	onCopy(what: "model" | "thinking"): void;
}

/** Presentation shared by the desktop popover and the phone sheet. */
export function ControlsBody(props: ControlsBodyProps): ReactNode {
	const { models, modelsError, thinking, busy, pending, error, note, successVisible = false } = props;
	return (
		<div className="sc-body">
			<p className="sc-scope" role="note">
				Session-only: this changes the main agent of this session and <strong>does not change your omp default</strong>{" "}
				(Settings &gt; Model roles edits the defaults).
			</p>

			<section className="sc-section" aria-label="model">
				<h3 className="sc-title">
					Model
					<span className="sc-current">
						{busy === "model" && <ActionFeedbackMark state="pending" />}
						{busy === "model" && pending ? `switching to ${shortModelName(pending)}…` : (props.modelLabel ?? "unknown")}
					</span>
				</h3>
				<ModelPicker
					models={models}
					error={modelsError}
					current={props.selector}
					busy={busy !== null}
					onPick={props.onPickModel}
					onRetry={props.onRetryModels}
				/>
				{error?.control === "model" ? (
					<div className="sc-msg sc-msg-err" role="alert">
						<ActionFeedbackMark state="failure" />
						{error.message}
					</div>
				) : null}
				<OmpLine text={modelEquivalent(props.selector)} onCopy={() => props.onCopy("model")} />
			</section>

			<section className="sc-section" aria-label="thinking">
				<h3 className="sc-title">
					Thinking
					<span className="sc-current">
						{busy === "thinking" && <ActionFeedbackMark state="pending" />}
						{busy === "thinking" && pending ? `setting ${pending}…` : (thinking ?? "unknown")}
					</span>
				</h3>
				<div className="sc-seg" role="radiogroup" aria-label="thinking level">
					{THINKING_LEVELS.map(level => (
						<button
							key={level}
							type="button"
							role="radio"
							aria-checked={thinking === level}
							className="sc-seg-btn"
							data-on={thinking === level ? "true" : "false"}
							disabled={busy !== null}
							onClick={() => props.onPickThinking(level)}
						>
							{level}
						</button>
					))}
				</div>
				{error?.control === "thinking" ? (
					<div className="sc-msg sc-msg-err" role="alert">
						<ActionFeedbackMark state="failure" />
						{error.message}
					</div>
				) : null}
				<OmpLine text={thinkingEquivalent(thinking)} onCopy={() => props.onCopy("thinking")} />
			</section>

			{note ? (
				<div className="sc-msg sc-msg-ok" role="status">
					{successVisible && <ActionFeedbackMark state="success" />}
					{note}
				</div>
			) : null}
		</div>
	);
}
