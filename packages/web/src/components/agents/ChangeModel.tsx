import type { ListModelsResponse } from "@omp-console/protocol";
import { Cpu } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DeckApi } from "../../lib/api";
import { describeControlError } from "../../lib/agent-api";
import { changeAgentModel, labelForSelector, type ModelPickItem } from "../../lib/agent-models";
import { ModelPicker } from "./ModelPicker";
import "./agents.css";
import { ActionFeedbackMark } from "../shell/ActionFeedback";

type Outcome = { ok: true; text: string } | { ok: false; text: string };

/**
 * "Change model" for one agent of a live session: opens a picker over `GET /api/models`, sends the pick to
 * `POST /api/sessions/:id/agents/:agentId/model` and shows the result or the daemon's refusal in place. The
 * override lasts for this session only; the persisted defaults are Settings > Model roles.
 */
export function ChangeModel(props: {
	sessionId: string;
	agentId: string;
	agentName: string;
	/** Model the agent reports now (from progress), to mark in the list. */
	currentModel?: string;
	api: DeckApi;
	/** Start with the picker open (the graph's node menu already said "Change model"). */
	defaultOpen?: boolean;
}): ReactNode {
	const { sessionId, agentId, agentName, currentModel, api, defaultOpen = false } = props;
	const [open, setOpen] = useState(defaultOpen);
	const [models, setModels] = useState<ListModelsResponse | null>(null);
	const [modelsError, setModelsError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [outcome, setOutcome] = useState<Outcome | null>(null);
	const [active, setActive] = useState<string | undefined>(currentModel);
	const [successVisible, setSuccessVisible] = useState(false);
	const mounted = useRef(true);

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	useEffect(() => {
		if (!outcome?.ok) {
			setSuccessVisible(false);
			return;
		}
		setSuccessVisible(true);
		const timer = window.setTimeout(() => setSuccessVisible(false), 700);
		return () => window.clearTimeout(timer);
	}, [outcome]);
	useEffect(() => setActive(currentModel), [currentModel]);
	useEffect(() => {
		if (defaultOpen) void loadModels();
		// Once, on mount: the picker was asked for open.
		// biome-ignore lint/correctness/useExhaustiveDependencies: see above
	}, []);

	const loadModels = useCallback(async () => {
		setModelsError(null);
		try {
			const list = await api.listModels();
			if (mounted.current) setModels(list);
		} catch (err) {
			if (mounted.current) setModelsError(describeControlError(err, "load"));
		}
	}, [api]);

	const toggle = (): void => {
		const next = !open;
		setOpen(next);
		if (next && models === null) void loadModels();
	};

	const pick = async (item: ModelPickItem): Promise<void> => {
		if (busy) return;
		setBusy(true);
		setOutcome(null);
		try {
			const result = await changeAgentModel(api, sessionId, agentId, item.selector);
			if (!mounted.current) return;
			if (result.ok) {
				setActive(result.model);
				setOutcome({
					ok: true,
					text: `${agentName} now uses ${labelForSelector(models, result.model)}${result.thinkingLevel ? ` (thinking ${result.thinkingLevel})` : ""}. This session only.`,
				});
				setOpen(false);
			} else {
				setOutcome({ ok: false, text: result.message });
			}
		} catch (error) {
			if (mounted.current) setOutcome({ ok: false, text: describeControlError(error, "agent-model") });
		} finally {
			if (mounted.current) setBusy(false);
		}
	};

	return (
		<div className="ag-change-model">
			<button
				type="button"
				className="ag-btn"
				aria-expanded={open}
				aria-controls={`ag-model-${agentId}`}
				disabled={busy}
				onClick={toggle}
			>
				<Cpu size={13} aria-hidden />
				Change model
			</button>
			{busy && <div className="ag-inline-note" role="status"><ActionFeedbackMark state="pending" /> Switching model…</div>}
			{outcome && (
				<div
					className={outcome.ok ? "ag-inline-note ag-inline-note--ok" : "ag-inline-note ag-inline-note--err"}
					role={outcome.ok ? "status" : "alert"}
				>
					<ActionFeedbackMark state={outcome.ok ? (successVisible ? "success" : "idle") : "failure"} />
					{outcome.text}
				</div>
			)}
			{open ? (
				<div id={`ag-model-${agentId}`} className="ag-change-model-panel">
					<ModelPicker
						models={models}
						error={modelsError}
						current={active}
						busy={busy}
						onPick={item => void pick(item)}
						onRetry={() => void loadModels()}
					/>
				</div>
			) : null}
		</div>
	);
}
