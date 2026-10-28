import type { CleanseCheckerDescriptor, CleanseRunSnapshot, OmfgCandidate } from "@omp-console/protocol";
import { ExternalLink, LoaderCircle, Play, Save, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DeckApi } from "../../lib/api";
import { openAgent } from "../agents/graph-events";
import { Sheet } from "../shell/Sheet";
import "./terminal-commands.css";

export interface TerminalCommandsDialogProps {
	api: DeckApi;
	sessionId: string | undefined;
	panel: string;
	command?: string;
	args?: string;
	onClose(): void;
}

interface PanelProps {
	api: DeckApi;
	sessionId: string | undefined;
	args: string;
	onClose(): void;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function TerminalCommandsDialog({ api, sessionId, panel, args = "", onClose }: TerminalCommandsDialogProps): ReactNode {
	const props = { api, sessionId, args, onClose };
	if (panel === "tan") return <TanDialog {...props} />;
	if (panel === "omfg") return <OmfgDialog {...props} />;
	if (panel === "cleanse") return <CleanseDialog {...props} />;
	return null;
}

function TanDialog({ api, sessionId, args, onClose }: PanelProps): ReactNode {
	const [work, setWork] = useState(args);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const [job, setJob] = useState<{ jobId: string; agentId: string }>();
	const autoStarted = useRef("");

	const start = useCallback(async (task: string): Promise<void> => {
		if (!sessionId) {
			setError("Connect to a live session before starting a Tan agent.");
			return;
		}
		if (!task.trim()) {
			setError("Describe the work for the background Tan agent.");
			return;
		}
		setBusy(true);
		setError(undefined);
		setJob(undefined);
		try {
			const result = await api.sessionOpV3(sessionId, { op: "tan-start", work: task });
			if (!("agentId" in result && "jobId" in result)) throw new Error("The worker did not return the Tan agent.");
			setJob({ agentId: result.agentId, jobId: result.jobId });
		} catch (caught) {
			setError(errorText(caught));
		} finally {
			setBusy(false);
		}
	}, [api, sessionId]);

	useEffect(() => {
		const task = args.trim();
		if (task === "" || autoStarted.current === task) return;
		autoStarted.current = task;
		void start(task);
	}, [args, start]);

	return (
		<Sheet title="/tan · background agent" onClose={onClose} size="full" windowKind="terminal-tan">
			<div className="tc-panel">
				<p className="tc-help">Fork the session context into a separate background session. Its result appears in Agents.</p>
				<label className="tc-field">
					<span>Work</span>
					<textarea className="tc-textarea" value={work} onChange={event => setWork(event.currentTarget.value)} rows={6} autoFocus />
				</label>
				<div className="tc-actions">
					<button type="button" className="sh-btn sh-btn-primary" disabled={busy || !work.trim()} onClick={() => void start(work)}>
						{busy ? <LoaderCircle size={16} className="tc-spin" /> : <Play size={16} />}
						{busy ? "Starting…" : "Start background agent"}
					</button>
					<button type="button" className="sh-btn" onClick={onClose}>Close</button>
				</div>
				{error && <p className="tc-error" role="alert">{error}</p>}
				{job && (
					<div className="tc-result" role="status">
						<p>Tan agent dispatched. Job: <code>{job.jobId}</code></p>
						<button type="button" className="sh-btn" onClick={() => openAgent(job.agentId)}>
							<ExternalLink size={15} /> Open {job.agentId} in Agents
						</button>
					</div>
				)}
			</div>
		</Sheet>
	);
}

function OmfgDialog({ api, sessionId, args, onClose }: PanelProps): ReactNode {
	const [complaint, setComplaint] = useState(args);
	const [candidate, setCandidate] = useState<OmfgCandidate>();
	const [fileContent, setFileContent] = useState("");
	const [scope, setScope] = useState<"project" | "user">("project");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const [status, setStatus] = useState<string>();
	const [overwriteConfirmation, setOverwriteConfirmation] = useState<{
		path: string;
		scope: "project" | "user";
		fileContent: string;
	}>();
	const [needsUnvalidated, setNeedsUnvalidated] = useState(false);
	const requestId = useRef<string | undefined>(undefined);
	const autoStarted = useRef("");

	const generate = useCallback(async (description: string): Promise<void> => {
		if (!sessionId) {
			setError("Connect to a live session before generating a rule.");
			return;
		}
		if (!description.trim()) {
			setError("Describe the recurring behavior this rule should prevent.");
			return;
		}
		const id = crypto.randomUUID();
		requestId.current = id;
		setBusy(true);
		setError(undefined);
		setStatus(undefined);
		setCandidate(undefined);
		setFileContent("");
		setOverwriteConfirmation(undefined);
		setNeedsUnvalidated(false);
		try {
			const result = await api.sessionOpV3(sessionId, { op: "omfg-generate", requestId: id, complaint: description });
			if (!("candidate" in result) || requestId.current !== id) return;
			setCandidate(result.candidate);
			setFileContent(result.candidate.fileContent);
		} catch (caught) {
			if (requestId.current === id) setError(errorText(caught));
		} finally {
			if (requestId.current === id) setBusy(false);
		}
	}, [api, sessionId]);
	const overwriteConfirmed =
		overwriteConfirmation?.scope === scope && overwriteConfirmation.fileContent === fileContent;

	useEffect(() => {
		const description = args.trim();
		if (description === "" || autoStarted.current === description) return;
		autoStarted.current = description;
		void generate(description);
	}, [args, generate]);

	const cancelRequest = (): void => {
		const id = requestId.current;
		requestId.current = undefined;
		if (id && sessionId) void api.sessionOpV3(sessionId, { op: "omfg-cancel", requestId: id }).catch(() => {});
	};

	const close = (): void => {
		cancelRequest();
		onClose();
	};

	const save = async (overwrite: boolean, acceptUnvalidated: boolean): Promise<void> => {
		if (!sessionId || !candidate) return;
		setBusy(true);
		setError(undefined);
		setStatus(undefined);
		try {
			const result = await api.sessionOpV3(sessionId, {
				op: "omfg-save",
				requestId: candidate.requestId,
				fileContent,
				scope,
				overwrite,
				acceptUnvalidated,
			});
			if (!("save" in result)) throw new Error("The worker did not return the save result.");
			if (result.save.kind === "confirm-overwrite") {
				setOverwriteConfirmation({ path: result.save.path, scope, fileContent });
				setStatus(`Rule already exists at ${result.save.path}; accept again to replace it.`);
				return;
			}
			if (result.save.kind === "confirm-unvalidated") {
				setNeedsUnvalidated(true);
				setStatus(result.save.message);
				return;
			}
			setNeedsUnvalidated(false);
			setOverwriteConfirmation(undefined);
			setStatus(`Saved ${result.save.path}`);
			setCandidate(undefined);
		} catch (caught) {
			setError(errorText(caught));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Sheet title="/omfg · Command summary rule" onClose={close} size="full" windowKind="terminal-omfg">
			<div className="tc-panel">
				<p className="tc-help">Generate a rule from recent assistant and tool history. Review or edit it; nothing is saved until you accept.</p>
				<label className="tc-field">
					<span>Recurring behavior</span>
					<textarea className="tc-textarea" value={complaint} onChange={event => setComplaint(event.currentTarget.value)} rows={3} />
				</label>
				<div className="tc-actions">
					<button type="button" className="sh-btn sh-btn-primary" disabled={busy || !complaint.trim()} onClick={() => void generate(complaint)}>
						{busy && !candidate ? <LoaderCircle size={16} className="tc-spin" /> : <Play size={16} />}
						{busy && !candidate ? "Generating…" : candidate ? "Regenerate" : "Generate rule"}
					</button>
					<button type="button" className="sh-btn" onClick={close}><X size={16} /> Cancel</button>
				</div>
				{error && <p className="tc-error" role="alert">{error}</p>}
				{candidate && (
					<>
						<p className={candidate.validated ? "tc-status" : "tc-warning"} role="status">
							{candidate.validated ? "Matched against recent conversation history." : candidate.validationMessage ?? "Couldn't confirm a conversation match."}
						</p>
						<label className="tc-field">
							<span>Rule · {candidate.name}.md</span>
							<textarea className="tc-textarea tc-code" value={fileContent} onChange={event => {
								setFileContent(event.currentTarget.value);
								setOverwriteConfirmation(undefined);
								setNeedsUnvalidated(false);
								setStatus(undefined);
							}} rows={14} spellCheck={false} />
						</label>
						<label className="tc-field tc-inline-field">
							<span>Save to</span>
							<select className="tc-select" value={scope} onChange={event => {
								setScope(event.currentTarget.value as "project" | "user");
								setOverwriteConfirmation(undefined);
								setNeedsUnvalidated(false);
								setStatus(undefined);
							}}>
								<option value="project">This project · .omp/rules</option>
								<option value="user">User rules · all projects</option>
							</select>
						</label>
						<div className="tc-actions">
							<button
								type="button"
								className="sh-btn sh-btn-primary"
								disabled={busy || fileContent.trim() === ""}
								title={overwriteConfirmed ? `Replace ${overwriteConfirmation.path}` : undefined}
								onClick={() => void save(overwriteConfirmed, false)}
							>
								{busy ? <LoaderCircle size={16} className="tc-spin" /> : <Save size={16} />}
								{overwriteConfirmed ? "Confirm overwrite" : "Accept and save"}
							</button>
							{needsUnvalidated && <button type="button" className="sh-btn sh-btn-stop" disabled={busy} onClick={() => void save(overwriteConfirmed, true)}>Accept without match</button>}
							<button type="button" className="sh-btn" disabled={busy} onClick={close}>Cancel</button>
						</div>
					</>
					)}
				{status && <p className="tc-status" role="status">{status}</p>}
			</div>
		</Sheet>
	);
}

interface CleanseOptions {
	includeTests: boolean;
	maxAgents: string;
	model: string;
	scope: "all" | "checker" | "request";
	checkerId: string;
	request: string;
}

function parseCleanseArgs(args: string): CleanseOptions {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const request: string[] = [];
	let includeTests = false;
	let maxAgents = "32";
	let model = "";
	let scope: CleanseOptions["scope"] = "all";
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]!;
		if (token === "--all" || token === "-a") scope = "all";
		else if (token === "--tests" || token === "-t") includeTests = true;
		else if (token === "--agents" || token === "-n") maxAgents = tokens[++index] ?? maxAgents;
		else if (token === "--model" || token === "-m") model = tokens[++index] ?? model;
		else if (token === "--request") {
			scope = "request";
			request.push(tokens[++index] ?? "");
		} else request.push(token);
	}
	if (request.length > 0) scope = "request";
	return { includeTests, maxAgents, model, scope, checkerId: "", request: request.join(" ") };
}

function CleanseDialog({ api, sessionId, args, onClose }: PanelProps): ReactNode {
	const initial = useRef(parseCleanseArgs(args));
	const [options, setOptions] = useState(initial.current);
	const [checkers, setCheckers] = useState<CleanseCheckerDescriptor[]>([]);
	const [skipped, setSkipped] = useState<string[]>([]);
	const [snapshot, setSnapshot] = useState<CleanseRunSnapshot | null>(null);
	const [discovering, setDiscovering] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();

	useEffect(() => {
		if (!sessionId) return;
		let current = true;
		setDiscovering(true);
		void api.sessionOpV3(sessionId, { op: "cleanse-discover", includeTests: options.includeTests })
			.then(result => {
				if (!("checkers" in result) || !current) return;
				setCheckers(result.checkers);
				setSkipped(result.skipped.map(item => `${item.label}: ${item.reason}`));
				setOptions(previous => ({
					...previous,
					checkerId: result.checkers.some(checker => checker.id === previous.checkerId)
						? previous.checkerId
						: result.checkers[0]?.id ?? "",
				}));
			})
			.catch(caught => { if (current) setError(errorText(caught)); })
			.finally(() => { if (current) setDiscovering(false); });
		return () => { current = false; };
	}, [api, options.includeTests, sessionId]);

	useEffect(() => {
		if (!sessionId) return;
		let current = true;
		let timer: number | undefined;
		let inFlight = false;
		const poll = async (): Promise<void> => {
			if (inFlight) return;
			inFlight = true;
			try {
				const result = await api.sessionOpV3(sessionId, { op: "cleanse-state" });
				if (!("state" in result) || !current) return;
				if (result.state !== null) setSnapshot(result.state);
				if (result.state?.status === "running" || snapshot?.status === "running") timer = window.setTimeout(() => void poll(), 900);
			} catch (caught) {
				if (current) setError(errorText(caught));
			} finally {
				inFlight = false;
			}
		};
		void poll();
		return () => {
			current = false;
			if (timer !== undefined) window.clearTimeout(timer);
		};
	}, [api, sessionId, snapshot?.runId, snapshot?.status]);

	const setOption = <K extends keyof CleanseOptions>(key: K, value: CleanseOptions[K]): void =>
		setOptions(previous => ({ ...previous, [key]: value }));

	const start = async (): Promise<void> => {
		if (!sessionId) {
			setError("Connect to a live session before running Cleanse.");
			return;
		}
		const maxAgents = Number(options.maxAgents);
		if (!Number.isInteger(maxAgents) || maxAgents <= 0) {
			setError("Max agents must be a positive integer.");
			return;
		}
		if (options.scope === "checker" && !options.checkerId) {
			setError("Select a checker or choose another scope.");
			return;
		}
		if (options.scope === "request" && !options.request.trim()) {
			setError("Describe the checker request.");
			return;
		}
		setBusy(true);
		setError(undefined);
		try {
			const scope = options.scope === "all"
				? { kind: "all" as const }
				: options.scope === "checker"
					? { kind: "checker" as const, id: options.checkerId }
					: { kind: "request" as const, request: options.request.trim() };
			const result = await api.sessionOpV3(sessionId, {
				op: "cleanse-start",
				runId: crypto.randomUUID(),
				scope,
				includeTests: options.includeTests,
				maxAgents,
				...(options.model.trim() ? { model: options.model.trim() } : {}),
			});
			if (!("runId" in result)) throw new Error("The worker did not accept the Cleanse run.");
			setSnapshot({
				runId: result.runId,
				status: "running",
				phase: "Starting cleanse…",
				checkers: [],
				agents: [],
				logs: [],
			});
		} catch (caught) {
			setError(errorText(caught));
		} finally {
			setBusy(false);
		}
	};

	const cancel = async (): Promise<void> => {
		if (!sessionId || snapshot?.status !== "running") return;
		setBusy(true);
		try {
			await api.sessionOpV3(sessionId, { op: "cleanse-cancel", runId: snapshot.runId });
		} catch (caught) {
			setError(errorText(caught));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Sheet title="/cleanse · diagnostics and repairs" onClose={onClose} size="full" windowKind="terminal-cleanse">
			<div className="tc-panel">
				<p className="tc-help">Choose built-in diagnostics or describe a custom checker. Progress, repair agents and verification results stay visible here.</p>
				<div className="tc-cleanse-options">
					<label className="tc-radio"><input type="radio" name="cleanse-scope" checked={options.scope === "all"} onChange={() => setOption("scope", "all")} /> All discovered checkers</label>
					<label className="tc-radio"><input type="radio" name="cleanse-scope" checked={options.scope === "checker"} onChange={() => setOption("scope", "checker")} /> One checker</label>
					<label className="tc-radio"><input type="radio" name="cleanse-scope" checked={options.scope === "request"} onChange={() => setOption("scope", "request")} /> Custom checker request</label>
				</div>
				{options.scope === "checker" && (
					<label className="tc-field">
						<span>Checker</span>
						<select className="tc-select" value={options.checkerId} onChange={event => setOption("checkerId", event.currentTarget.value)} disabled={discovering || checkers.length === 0}>
							{checkers.map(checker => <option key={checker.id} value={checker.id}>{checker.label} · {checker.language}</option>)}
						</select>
					</label>
				)}
				{options.scope === "request" && (
					<label className="tc-field"><span>Checker request</span><textarea className="tc-textarea" rows={3} value={options.request} onChange={event => setOption("request", event.currentTarget.value)} /></label>
				)}
				<div className="tc-cleanse-fields">
					<label className="tc-field"><span>Max agents</span><input className="tc-input" type="number" min="1" value={options.maxAgents} onChange={event => setOption("maxAgents", event.currentTarget.value)} /></label>
					<label className="tc-field"><span>Model (optional)</span><input className="tc-input" value={options.model} onChange={event => setOption("model", event.currentTarget.value)} placeholder="default: @smol" /></label>
					<label className="tc-checkbox"><input type="checkbox" checked={options.includeTests} onChange={event => setOption("includeTests", event.currentTarget.checked)} /> Include test checkers</label>
				</div>
				<div className="tc-actions">
					<button type="button" className="sh-btn sh-btn-primary" disabled={busy || discovering || snapshot?.status === "running"} onClick={() => void start()}>
						{busy || discovering ? <LoaderCircle size={16} className="tc-spin" /> : <Play size={16} />}
						{snapshot?.status === "running" ? "Cleanse running…" : discovering ? "Discovering…" : "Start Cleanse"}
					</button>
					{snapshot?.status === "running" && <button type="button" className="sh-btn sh-btn-stop" disabled={busy} onClick={() => void cancel()}>Cancel run</button>}
					<button type="button" className="sh-btn" onClick={onClose}>Close</button>
				</div>
				{error && <p className="tc-error" role="alert">{error}</p>}
				{skipped.length > 0 && <details className="tc-details"><summary>{skipped.length} unavailable checker(s)</summary><ul>{skipped.map(item => <li key={item}>{item}</li>)}</ul></details>}
				{snapshot && <CleanseBoard snapshot={snapshot} />}
			</div>
		</Sheet>
	);
}

function CleanseBoard({ snapshot }: { snapshot: CleanseRunSnapshot }): ReactNode {
	return (
		<section className="tc-board" aria-label="Cleanse progress">
			<header className="tc-board-head"><strong>Run {snapshot.runId}</strong><span className={`tc-pill tc-${snapshot.status}`}>{snapshot.status}</span></header>
			{snapshot.phase && <p className="tc-status" role="status">{snapshot.phase}</p>}
			{snapshot.error && <p className="tc-error">{snapshot.error}</p>}
			{snapshot.checkers.length > 0 && (
				<div className="tc-board-section"><h3>Checkers</h3><ul className="tc-list">{snapshot.checkers.map(row => (
					<li key={row.checker.id}><span>{row.checker.label}</span><span>{row.status}{row.result ? ` · ${row.result.diagnosticCount ?? 0} diagnostics` : ""}</span></li>
				))}</ul></div>
			)}
			{snapshot.agents.length > 0 && (
				<div className="tc-board-section"><h3>Repair agents</h3><ul className="tc-agent-list">{snapshot.agents.map(agent => (
					<li key={agent.name}>
						<div className="tc-agent-head"><strong>{agent.name}</strong><span>{agent.status} · weight {agent.weight}</span></div>
						{agent.files.length > 0 && <small>{agent.files.join(", ")}</small>}
						{agent.progress?.currentTool && <small>Tool: {agent.progress.currentTool}</small>}
						{agent.progress?.lastIntent && <small>{agent.progress.lastIntent}</small>}
						{agent.error && <p className="tc-error">{agent.error}</p>}
						{agent.output && <pre>{agent.output}</pre>}
					</li>
				))}</ul></div>
			)}
			{snapshot.result && (
				<div className="tc-board-section"><h3>Verification · {snapshot.result.diagnostics.length} remaining</h3>
					{snapshot.result.diagnostics.map((diagnostic, index) => <p className="tc-diagnostic" key={`${diagnostic.checker}:${diagnostic.file ?? ""}:${index}`}>
						<strong>{diagnostic.severity}</strong> {diagnostic.file ? `${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}` : ""}: ` : ""}{diagnostic.message}
					</p>)}
				</div>
			)}
			{snapshot.logs.length > 0 && <details className="tc-details"><summary>Run log</summary><ol>{snapshot.logs.map((line, index) => <li key={`${index}:${line}`}>{line}</li>)}</ol></details>}
		</section>
	);
}
