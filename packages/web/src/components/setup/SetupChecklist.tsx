import { CheckCircle2, CircleAlert, CircleHelp, RefreshCw, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { ClaudeImportSummary, SetupResponse } from "@omp-console/protocol";
import { DeckApi, DeckApiError } from "../../lib/api";
import { openPanel } from "../../lib/palette";
import "./setup.css";

const INSTALL_OMP = "bun install -g @oh-my-pi/pi-coding-agent";
const MODEL_LOGIN_STEPS = "Run omp, then /login, choose Anthropic.\nOr add PROVIDER_API_KEY=... to ~/.omp-console/env and restart omp-console.";
const LOGS_COMMAND = "~/.local/bin/omp-console logs";

type Check<T> = { kind: "loading" } | { kind: "ready"; value: T } | { kind: "error"; message: string };
type ClaudeCheck = Check<ClaudeImportSummary> | { kind: "hidden" };

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function SetupRow({
	label,
	status,
	children,
	action,
	statusKind = "info",
}: {
	label: string;
	status: string;
	children: ReactNode;
	action?: { label: string; onClick(): void };
	statusKind?: "ready" | "action" | "error" | "info";
}): ReactNode {
	const Icon = statusKind === "ready" ? CheckCircle2 : statusKind === "action" || statusKind === "error" ? CircleAlert : CircleHelp;
	return (
		<li className="dk-setup-row" data-status={statusKind}>
			<Icon size={17} aria-hidden="true" />
			<div className="dk-setup-row-content">
				<div className="dk-setup-row-heading"><strong>{label}</strong><span>{status}</span></div>
				<div className="dk-setup-row-detail">{children}</div>
				{action && <button type="button" className="dk-setup-action" onClick={action.onClick}>{action.label}</button>}
			</div>
		</li>
	);
}

export interface SetupChecklistProps {
	api: Pick<DeckApi, "setup" | "getClaudeImportSummary">;
	onStartSession(): void;
	onOpenExistingSessions(): void;
	onDismiss?(): void;
}

export function SetupChecklist({ api, onStartSession, onOpenExistingSessions, onDismiss }: SetupChecklistProps): ReactNode {
	const [checks, setChecks] = useState<Check<SetupResponse>>({ kind: "loading" });
	const [claude, setClaude] = useState<ClaudeCheck>({ kind: "loading" });
	const [reload, setReload] = useState(0);
	const [actionMessage, setActionMessage] = useState<string | null>(null);
	useEffect(() => {
		const controller = new AbortController();
		setChecks({ kind: "loading" });
		setClaude({ kind: "loading" });
		void api.setup(controller.signal).then(
			value => setChecks({ kind: "ready", value }),
			error => {
				if (!controller.signal.aborted) setChecks({ kind: "error", message: errorMessage(error) });
			},
		);
		void api.getClaudeImportSummary("claude", controller.signal).then(
			value => setClaude({ kind: "ready", value }),
			error => {
				if (controller.signal.aborted) return;
				if (error instanceof DeckApiError && error.status === 404) setClaude({ kind: "hidden" });
				else setClaude({ kind: "error", message: errorMessage(error) });
			},
		);
		return () => controller.abort();
	}, [api, reload]);

	const copy = async (text: string, label: string): Promise<void> => {
		try {
			await navigator.clipboard.writeText(text);
			setActionMessage(`${label} copied.`);
		} catch {
			setActionMessage(`Clipboard is unavailable. Use: ${text}`);
		}
	};
	const setup = checks.kind === "ready" ? checks.value : null;
	const setupError = checks.kind === "error" ? checks.message : null;
	return (
		<section className="dk-setup-checklist" aria-label="First-run setup checklist">
			<header className="dk-setup-header">
				<div><h2>First-run setup</h2><p>Check omp, your existing sessions, and sign-in. No model is called.</p></div>
				{onDismiss && <button type="button" className="dk-setup-dismiss" onClick={onDismiss} aria-label="Dismiss setup checklist"><X size={17} /></button>}
			</header>
			{setupError !== null && (
				<div className="dk-setup-load-error" role="alert">
					<p>Setup checks could not load: {setupError}</p>
					<button type="button" className="dk-setup-action" onClick={() => setReload(value => value + 1)}><RefreshCw size={14} /> Retry checks</button>
				</div>
			)}
			<ul className="dk-setup-rows">
				{checks.kind === "loading" && <SetupRow label="Checking setup" status="Loading" statusKind="info">Reading your local omp configuration.</SetupRow>}
				{setup && (
					<>
						<SetupRow
							label="omp"
							status={setup.omp.found ? (setup.omp.error ? "Found, version unavailable" : "Ready") : "Install needed"}
							statusKind={setup.omp.found ? (setup.omp.error ? "error" : "ready") : "action"}
							action={setup.omp.found
								? { label: "Copy omp path", onClick: () => void copy(setup.omp.path ?? "omp", "omp path") }
								: { label: "Copy install command", onClick: () => void copy(INSTALL_OMP, "Install command") }}
						>
							{setup.omp.found
								? <>{setup.omp.version ?? setup.omp.error} · <code>{setup.omp.path}</code></>
								: <>omp was not found on PATH, in <code>~/.bun/bin</code>, or in <code>~/.local/bin</code>. Install it with <code>{INSTALL_OMP}</code>, then sign in with <code>omp</code> and <code>/login</code>.</>}
						</SetupRow>
						<SetupRow
							label="Model sign-in"
							status={setup.models.error ? "Could not check" : setup.models.availableCount === 0 ? "Sign-in needed" : `${setup.models.availableCount} model${setup.models.availableCount === 1 ? "" : "s"} ready`}
							statusKind={setup.models.error ? "error" : setup.models.availableCount === 0 ? "action" : "ready"}
							action={{ label: setup.models.availableCount === 0 || setup.models.error ? "Copy sign-in steps" : "Copy model name", onClick: () => void copy(setup.models.error || setup.models.availableCount === 0 ? MODEL_LOGIN_STEPS : setup.models.defaultModel ?? "omp", setup.models.availableCount === 0 ? "Sign-in steps" : "Model name") }}
						>
							{setup.models.error
								? setup.models.error
								: setup.models.availableCount === 0
									? <>0 models are ready. For a Claude subscription, run <code>omp</code>, then <code>/login</code>, choose Anthropic. Or add <code>PROVIDER_API_KEY=...</code> to <code>~/.omp-console/env</code>.</>
									: <>No model call was made.{setup.models.defaultModel && <> Default: <code>{setup.models.defaultModel}</code>.</>}</>}
						</SetupRow>
						<SetupRow
							label="Existing omp sessions"
							status={setup.sessions.error ? "Could not scan" : `${setup.sessions.count ?? 0} found`}
							statusKind={setup.sessions.error ? "error" : (setup.sessions.count ?? 0) === 0 ? "action" : "ready"}
							action={setup.sessions.error
								? { label: "Copy log command", onClick: () => void copy(LOGS_COMMAND, "Log command") }
								: (setup.sessions.count ?? 0) > 0
									? { label: "Open sessions", onClick: onOpenExistingSessions }
									: { label: "Start a session", onClick: onStartSession }}
						>
							{setup.sessions.error ?? <>Looking in <code>{setup.sessions.agentDir}</code>.</>}
						</SetupRow>
						{claude.kind !== "hidden" && (
							<SetupRow
								label="Claude Code history"
								status={claude.kind === "loading" ? "Checking" : claude.kind === "error" ? "Could not check" : claude.value.found ? `${claude.value.sessionCount} sessions · ${claude.value.projectCount} projects` : "Not found"}
								statusKind={claude.kind === "error" ? "error" : claude.kind === "ready" && claude.value.found ? "ready" : "info"}
								action={{ label: "Open Claude Code import", onClick: () => openPanel({ panel: "claude-import" }) }}
							>
								{claude.kind === "error" ? claude.message : claude.kind === "ready" ? claude.value.found ? <>Found conversations in <code>{claude.value.dir}</code>.</> : <>No Claude Code history was found in <code>{claude.value.dir}</code>.</> : "Looking for Claude Code conversations on this computer."}
							</SetupRow>
						)}
						<SetupRow
							label="Your omp setup"
							status={setup.ompSetup.error ? "Could not read all settings" : setup.ompSetup.usesDefaultAgentDir ? "Default folder" : "Custom folder"}
							statusKind={setup.ompSetup.error ? "error" : "info"}
							action={{ label: "Copy active folder", onClick: () => void copy(setup.ompSetup.agentDir, "Active folder") }}
						>
							<code>{setup.ompSetup.agentDir}</code>{setup.ompSetup.error ? <> · {setup.ompSetup.error}</> : <> · {setup.ompSetup.modelRoles ?? 0} model roles · {setup.ompSetup.skills ?? 0} skills · {setup.ompSetup.extensions ?? 0} extensions · {setup.ompSetup.mcpServers ?? 0} MCP servers</>}
							{setup.ompSetup.defaultModel && <> · default model <code>{setup.ompSetup.defaultModel}</code></>}
							{setup.envKeys.length > 0 && <> · env keys: {setup.envKeys.join(", ")}</>}
						</SetupRow>
					</>
				)}
			</ul>
			{actionMessage && <p className="dk-setup-feedback" role="status">{actionMessage}</p>}
			<button type="button" className="dk-wide-btn dk-wide-btn-primary dk-setup-start" onClick={onStartSession}>Start your first session</button>
		</section>
	);
}
