import type { DebugAdapterOption, DebugSessionOp, DebugSessionOpResult, DebugSessionSummary, DebugStackFrame, DebugThread, SessionOpV3Result } from "@omp-console/protocol";
import { ChevronRight, CircleStop, Play, RefreshCw } from "lucide-react";
import type { ReactNode, SubmitEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import type { DeckApi } from "../../lib/api";
import { Sheet } from "../shell/Sheet";
import { DebugDiagnosticsPanel } from "./DebugDiagnosticsPanel";
import "./debug.css";

export interface DebugPanelProps {
	api: Pick<DeckApi, "sessionOpV3">;
	sessionId: string | undefined;
	readOnly: boolean;
	command?: string;
	args?: string;
	onClose(): void;
}

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : "The debugger operation failed.";
}

function isDebugResult(result: SessionOpV3Result): result is DebugSessionOpResult {
	return "debugAdapters" in result || "debugSessions" in result || "debugSession" in result;
}

export function DebugPanel({ api, sessionId, command, args, readOnly, onClose }: DebugPanelProps): ReactNode {
	const [tab, setTab] = useState<"diagnostics" | "dap">("diagnostics");
	const [adapters, setAdapters] = useState<DebugAdapterOption[]>([]);
	const [sessions, setSessions] = useState<DebugSessionSummary[]>([]);
	const [selected, setSelected] = useState<DebugSessionSummary | null>(null);
	const [threads, setThreads] = useState<DebugThread[]>([]);
	const [stack, setStack] = useState<DebugStackFrame[]>([]);
	const [scopes, setScopes] = useState<Array<{ name: string; variablesReference: number; expensive?: boolean }>>([]);
	const [variables, setVariables] = useState<Array<{ name: string; value: string; type?: string; variablesReference: number }>>([]);
	const [output, setOutput] = useState("");
	const [evaluation, setEvaluation] = useState("");
	const [expression, setExpression] = useState("");
	const [program, setProgram] = useState(args ?? "");
	const [programArgs, setProgramArgs] = useState("");
	const [attachPid, setAttachPid] = useState("");
	const [attachPort, setAttachPort] = useState("");
	const [attachHost, setAttachHost] = useState("127.0.0.1");
	const [adapterName, setAdapterName] = useState("");
	const [confirmAction, setConfirmAction] = useState<"launch" | "attach" | null>(null);
	const [selectedFrame, setSelectedFrame] = useState<number | undefined>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const applyResult = useCallback((result: DebugSessionOpResult): void => {
		if ("debugAdapters" in result) {
			setAdapters(result.debugAdapters);
			setAdapterName(current => current || result.debugAdapters.find(adapter => adapter.available)?.name || "");
		}
		if ("debugSessions" in result) {
			setSessions(result.debugSessions);
			setSelected(current => {
				const id = result.activeSessionId ?? current?.id;
				return result.debugSessions.find(session => session.id === id) ?? null;
			});
		}
		if ("debugSession" in result) {
			setSelected(result.debugSession);
			setSessions(current => [result.debugSession, ...current.filter(session => session.id !== result.debugSession.id)]);
		}
		if ("debugThreads" in result) setThreads(result.debugThreads);
		if ("debugStack" in result) setStack(result.debugStack);
		if ("debugScopes" in result) setScopes(result.debugScopes);
		if ("debugVariables" in result) setVariables(result.debugVariables);
		if ("debugOutput" in result) setOutput(result.debugOutput);
		if ("debugValue" in result) setEvaluation(result.debugValue);
	}, []);

	const invoke = useCallback(async (operation: DebugSessionOp): Promise<DebugSessionOpResult | null> => {
		if (!sessionId) return null;
		if (readOnly && ["launch", "attach", "continue", "step-over", "step-in", "step-out", "pause", "terminate", "evaluate"].includes(operation.action)) return null;
		setBusy(true);
		setError(null);
		try {
			const result = await api.sessionOpV3(sessionId, operation);
			if (!isDebugResult(result)) throw new Error("The session returned an unexpected debugger result.");
			applyResult(result);
			return result;
		} catch (cause) {
			setError(errorMessage(cause));
			return null;
		} finally {
			setBusy(false);
		}
	}, [api, applyResult, readOnly, sessionId]);

	const refresh = useCallback(async (): Promise<void> => {
		await invoke({ op: "debug", action: "adapters" });
		await invoke({ op: "debug", action: "sessions" });
	}, [invoke]);

	useEffect(() => {
		setProgram(command === "debug" ? args ?? "" : "");
	}, [args, command]);

	useEffect(() => {
		let current = true;
		if (sessionId) {
			void Promise.all([
				api.sessionOpV3(sessionId, { op: "debug", action: "adapters" }),
				api.sessionOpV3(sessionId, { op: "debug", action: "sessions" }),
			]).then(([adapterResult, sessionResult]) => {
				if (!current) return;
				if (!isDebugResult(adapterResult) || !isDebugResult(sessionResult)) throw new Error("The session returned an unexpected debugger result.");
				applyResult(adapterResult);
				applyResult(sessionResult);
			}).catch(cause => {
				if (current) setError(errorMessage(cause));
			});
		}
		return () => { current = false; };
	}, [api, applyResult, sessionId]);

	const selectSession = async (id: string): Promise<void> => {
		const result = await invoke({ op: "debug", action: "select", sessionId: id });
		if (result && "debugSession" in result) {
			setThreads([]);
			setStack([]);
			setScopes([]);
			setVariables([]);
			setSelectedFrame(undefined);
		}
	};

	const startLaunch = async (event: SubmitEvent<HTMLFormElement>): Promise<void> => {
		event.preventDefault();
		if (readOnly || !program.trim()) return;
		if (confirmAction !== "launch") {
			setConfirmAction("launch");
			return;
		}
		const argv = programArgs.split("\n").map(value => value.trim()).filter(Boolean);
		const operation: DebugSessionOp = {
			op: "debug",
			action: "launch",
			program: program.trim(),
			...(argv.length ? { args: argv } : {}),
			...(adapterName ? { adapter: adapterName } : {}),
			confirmed: true,
		};
		setConfirmAction(null);
		const result = await invoke(operation);
		if (result && "debugSession" in result) await invoke({ op: "debug", action: "threads" });
	};

	const startAttach = async (event: SubmitEvent<HTMLFormElement>): Promise<void> => {
		event.preventDefault();
		if (readOnly || (!attachPid.trim() && !attachPort.trim())) return;
		if (confirmAction !== "attach") {
			setConfirmAction("attach");
			return;
		}
		const pid = attachPid.trim() ? Number(attachPid) : undefined;
		const port = attachPort.trim() ? Number(attachPort) : undefined;
		if ((pid !== undefined && (!Number.isSafeInteger(pid) || pid <= 0)) || (port !== undefined && (!Number.isSafeInteger(port) || port <= 0 || port > 65535))) {
			setError("Enter a positive process id or a TCP port between 1 and 65535.");
			return;
		}
		const operation: DebugSessionOp = {
			op: "debug",
			action: "attach",
			...(pid === undefined ? {} : { pid }),
			...(port === undefined ? {} : { port }),
			...(attachHost.trim() ? { host: attachHost.trim() } : {}),
			...(adapterName ? { adapter: adapterName } : {}),
			confirmed: true,
		};
		setConfirmAction(null);
		await invoke(operation);
	};

	const inspect = async (action: "threads" | "stack" | "output"): Promise<void> => {
		await invoke({ op: "debug", action });
	};

	const requestScopes = async (frameId: number): Promise<void> => {
		setSelectedFrame(frameId);
		setVariables([]);
		await invoke({ op: "debug", action: "scopes", frameId });
	};

	const evaluate = async (event: SubmitEvent<HTMLFormElement>): Promise<void> => {
		event.preventDefault();
		if (readOnly || !expression.trim()) return;
		await invoke({ op: "debug", action: "evaluate", expression: expression.trim(), context: "watch", ...(selectedFrame === undefined ? {} : { frameId: selectedFrame }) });
	};

	const selectedAdapter = adapters.find(adapter => adapter.name === adapterName);
	return (
		<Sheet title="Debug" windowKind="debug" onClose={onClose}>
			<div className="debug-panel">
				<div className="debug-tabs" role="tablist" aria-label="Debug tools">
					<button type="button" role="tab" aria-selected={tab === "diagnostics"} onClick={() => setTab("diagnostics")}>Diagnostics</button>
					<button type="button" role="tab" aria-selected={tab === "dap"} onClick={() => setTab("dap")}>DAP sessions</button>
				</div>
				{tab === "diagnostics" ? <DebugDiagnosticsPanel api={api} sessionId={sessionId} readOnly={readOnly} /> : <div className="debug-dap-panel">
					{sessionId === undefined ? <p className="dk-hint" role="status">Open a daemon session to inspect its DAP adapters and sessions.</p> : null}
					<div className="debug-toolbar">
						<strong>Adapters</strong>
						<button type="button" className="sh-btn" onClick={() => void refresh()} disabled={busy}><RefreshCw size={13} aria-hidden="true" /> Refresh</button>
					</div>
					{error ? <p className="debug-error" role="alert">{error}</p> : null}
					<div className="debug-adapters" aria-label="Debug adapters">
						{adapters.length === 0 ? <p className="dk-hint">No DAP adapters are configured.</p> : adapters.map(adapter => <div className="debug-adapter" key={adapter.name} data-available={adapter.available}>
							<strong>{adapter.name}</strong><span>{adapter.available ? adapter.command : adapter.reason}</span><small>{adapter.languages.join(", ") || adapter.fileTypes.join(", ") || "No language metadata"}</small>
						</div>)}
					</div>
					<label className="debug-field">Adapter
						<select value={adapterName} onChange={event => setAdapterName(event.currentTarget.value)} disabled={busy}>
							<option value="">Automatic</option>
							{adapters.map(adapter => <option key={adapter.name} value={adapter.name} disabled={!adapter.available}>{adapter.name}{adapter.available ? "" : " (not installed)"}</option>)}
						</select>
					</label>
					{selectedAdapter && !selectedAdapter.available ? <p className="debug-error">Selected adapter is not installed: {selectedAdapter.reason}</p> : null}
					<div className="debug-start-grid">
						<form className="debug-form" onSubmit={event => void startLaunch(event)}>
							<h3>Launch program</h3>
							<label className="debug-field">Program path<input value={program} onChange={event => setProgram(event.currentTarget.value)} placeholder="./app.js" disabled={busy || readOnly} /></label>
							<label className="debug-field">Arguments · one per line<textarea value={programArgs} onChange={event => setProgramArgs(event.currentTarget.value)} rows={2} disabled={busy || readOnly} /></label>
							{confirmAction === "launch" ? <div className="debug-confirm" role="alert"><p>This will start a process in the session workspace. Confirm to launch the debug adapter and program.</p><button type="button" className="sh-btn" onClick={() => setConfirmAction(null)} disabled={busy}>Cancel</button><button type="submit" className="sh-btn sh-btn-primary" disabled={busy || readOnly}>Confirm launch</button></div> : <button type="submit" className="sh-btn sh-btn-primary" disabled={busy || readOnly || !sessionId || !program.trim()}>Launch…</button>}
						</form>
						<form className="debug-form" onSubmit={event => void startAttach(event)}>
							<h3>Attach</h3>
							<label className="debug-field">Process id<input inputMode="numeric" value={attachPid} onChange={event => setAttachPid(event.currentTarget.value)} disabled={busy || readOnly} /></label>
							<label className="debug-field">TCP port<input inputMode="numeric" value={attachPort} onChange={event => setAttachPort(event.currentTarget.value)} disabled={busy || readOnly} /></label>
							<label className="debug-field">Host<input value={attachHost} onChange={event => setAttachHost(event.currentTarget.value)} disabled={busy || readOnly} /></label>
							{confirmAction === "attach" ? <div className="debug-confirm" role="alert"><p>This will start an adapter process and attach to the selected target. Confirm before continuing.</p><button type="button" className="sh-btn" onClick={() => setConfirmAction(null)} disabled={busy}>Cancel</button><button type="submit" className="sh-btn sh-btn-primary" disabled={busy || readOnly}>Confirm attach</button></div> : <button type="submit" className="sh-btn" disabled={busy || readOnly || !sessionId || (!attachPid.trim() && !attachPort.trim())}>Attach…</button>}
						</form>
					</div>
					<section className="debug-sessions" aria-label="Debug sessions">
						<h3>Sessions</h3>
						{sessions.length === 0 ? <p className="dk-hint">No active DAP sessions.</p> : sessions.map(session => <button type="button" className="debug-session" key={session.id} data-selected={selected?.id === session.id} onClick={() => void selectSession(session.id)} disabled={busy}>
							<span><strong>{session.adapter}</strong><small>{session.program ?? session.id}</small></span><span className={`debug-state debug-state-${session.status}`}>{session.status}</span>
						</button>)}
					</section>
					{selected ? <section className="debug-details" aria-label="Selected debug session">
						<header><div><strong>{selected.program ?? selected.adapter}</strong><small>{selected.stopReason ?? selected.status}{selected.frameName ? ` · ${selected.frameName}` : ""}{selected.source?.path ? ` · ${selected.source.path}:${selected.line ?? "?"}` : ""}</small></div><button type="button" className="sh-btn" onClick={() => void selectSession(selected.id)} disabled={busy}>Select</button></header>
						<div className="debug-actions">
							<button type="button" className="sh-btn" onClick={() => void inspect("threads")} disabled={busy}>Threads</button>
							<button type="button" className="sh-btn" onClick={() => void inspect("stack")} disabled={busy}>Stack</button>
							<button type="button" className="sh-btn" onClick={() => void inspect("output")} disabled={busy}>Output</button>
							<button type="button" className="sh-btn" onClick={() => void invoke({ op: "debug", action: "continue" })} disabled={busy || readOnly}><Play size={13} aria-hidden="true" /> Continue</button>
							<button type="button" className="sh-btn" onClick={() => void invoke({ op: "debug", action: "step-over" })} disabled={busy || readOnly}>Step over</button>
							<button type="button" className="sh-btn" onClick={() => void invoke({ op: "debug", action: "step-in" })} disabled={busy || readOnly}>Step in</button>
							<button type="button" className="sh-btn" onClick={() => void invoke({ op: "debug", action: "step-out" })} disabled={busy || readOnly}>Step out</button>
							<button type="button" className="sh-btn" onClick={() => void invoke({ op: "debug", action: "pause" })} disabled={busy || readOnly}>Pause</button>
							<button type="button" className="sh-btn" onClick={() => void invoke({ op: "debug", action: "terminate" })} disabled={busy || readOnly}><CircleStop size={13} aria-hidden="true" /> Terminate</button>
						</div>
						{threads.length ? <div className="debug-list" aria-label="Threads">{threads.map(thread => <span key={thread.id}>{thread.name} · {thread.id}</span>)}</div> : null}
						{stack.length ? <div className="debug-list" aria-label="Stack frames">{stack.map(frame => <button type="button" key={frame.id} onClick={() => void requestScopes(frame.id)} disabled={busy}><ChevronRight size={12} aria-hidden="true" />{frame.name}{frame.source?.path ? ` · ${frame.source.path}:${frame.line ?? "?"}` : ""}</button>)}</div> : null}
						{scopes.length ? <div className="debug-list" aria-label="Scopes">{scopes.map(scope => <button type="button" key={`${scope.name}:${scope.variablesReference}`} onClick={() => void invoke({ op: "debug", action: "variables", reference: scope.variablesReference })} disabled={busy}>{scope.name}{scope.expensive ? " · expensive" : ""}</button>)}</div> : null}
						{variables.length ? <div className="debug-variables" aria-label="Variables">{variables.map(variable => <div key={`${variable.name}:${variable.variablesReference}`}><code>{variable.name}</code><span>{variable.type ? `${variable.type}: ` : ""}{variable.value}</span></div>)}</div> : null}
						<form className="debug-evaluate" onSubmit={event => void evaluate(event)}><label className="debug-field">Evaluate expression<input value={expression} onChange={event => setExpression(event.currentTarget.value)} disabled={busy || readOnly} /></label><button type="submit" className="sh-btn" disabled={busy || readOnly || !expression.trim()}>Evaluate</button></form>
						{evaluation ? <output className="debug-value">{evaluation}</output> : null}
						{output ? <pre className="debug-output">{output}</pre> : null}
					</section> : null}
				</div>}
			</div>
		</Sheet>
	);
}
