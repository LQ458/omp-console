import type { InstalledSkill, PendingUiRequest, SkillSearchHit, SkillSearchResult } from "@omp-console/protocol";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DeckApi } from "../../lib/api";
import { visibleUiRequestTitle } from "../../lib/ui-request-title";
import { Sheet } from "../shell/Sheet";
import "./skills.css";

export interface SkillsPanelProps {
	api: Pick<DeckApi, "sessionOpV3">;
	sessionId: string | undefined;
	readOnly: boolean;
	command?: string;
	args?: string;
	onClose(): void;
}

export type SkillCommandRequest =
	| { kind: "none" }
	| { kind: "invalid"; message: string }
	| { kind: "search"; query: string }
	| { kind: "installed" }
	| { kind: "install"; specs: string[]; global: boolean }
	| { kind: "update"; names: string[]; global: boolean };

export function parseSkillCommand(args = ""): SkillCommandRequest {
	const [verb = "", ...tokens] = args.trim().split(/\s+/).filter(Boolean);
	if (verb === "" || verb === "help") return { kind: "none" };
	if (verb === "search") {
		const query = tokens.join(" ").trim();
		return query ? { kind: "search", query } : { kind: "invalid", message: "Enter a search query." };
	}
	if (verb === "installed") return { kind: "installed" };
	if (verb !== "install" && verb !== "update") return { kind: "invalid", message: `Unknown /skills subcommand: ${verb}` };
	const names: string[] = [];
	let global = false;
	for (const token of tokens) {
		if (token === "-g" || token === "--global") global = true;
		else if (token.startsWith("-")) return { kind: "invalid", message: `Unknown skills option: ${token}` };
		else names.push(token);
	}
	if (verb === "install" && names.length === 0) return { kind: "invalid", message: "Usage: /skills install <@scope/name[@range]>… [-g]" };
	return verb === "install" ? { kind: "install", specs: names, global } : { kind: "update", names, global };
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function skillLabel(hit: SkillSearchHit): string {
	return `@${hit.scope}/${hit.name}`;
}

function formatChanges(changes: readonly { id: string; from?: string; to: string }[]): string {
	if (changes.length === 0) return "No skill changes were needed.";
	return changes
		.map(change => (change.from === undefined ? `Installed ${change.id}@${change.to}` : `Updated ${change.id}: ${change.from} → ${change.to}`))
		.join(" · ");
}
export function findSkillScriptApproval(requests: readonly PendingUiRequest[], approvalId: string): PendingUiRequest | null {
	const marker = `\n\n[omp-console-skill-approval:${approvalId}]`;
	const request = requests.find(
		candidate => candidate.title.startsWith("Install skill with scripts?\n") && candidate.title.endsWith(marker),
	);
	return request ? { ...request, title: visibleUiRequestTitle(request.title) } : null;
}

export function SkillsPanel({ api, sessionId, readOnly, command, args, onClose }: SkillsPanelProps): ReactNode {
	const [tab, setTab] = useState<"search" | "installed">("search");
	const [query, setQuery] = useState("");
	const [installSpec, setInstallSpec] = useState("");
	const [installGlobal, setInstallGlobal] = useState(false);
	const [searchResult, setSearchResult] = useState<SkillSearchResult | null>(null);
	const [installed, setInstalled] = useState<InstalledSkill[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [message, setMessage] = useState<string | null>(null);
	const [mutating, setMutating] = useState(false);
	const [approvalId, setApprovalId] = useState<string | null>(null);
	const [pendingScriptApproval, setPendingScriptApproval] = useState<PendingUiRequest | null>(null);
	const [answeringScriptApproval, setAnsweringScriptApproval] = useState(false);
	const operationController = useRef<AbortController | null>(null);
	useEffect(() => () => operationController.current?.abort(), []);

	const loadInstalled = useCallback(async (): Promise<void> => {
		if (!sessionId) return;
		setBusy(true);
		setError(null);
		try {
			const result = await api.sessionOpV3(sessionId, { op: "skills-installed" });
			if (!("installedSkills" in result)) throw new Error("The session did not return installed skills.");
			setInstalled(result.installedSkills);
		} catch (cause) {
			setError(errorText(cause));
		} finally {
			setBusy(false);
		}
	}, [api, sessionId]);

	const search = useCallback(async (value: string): Promise<void> => {
		if (!sessionId || value.trim() === "") return;
		setBusy(true);
		setError(null);
		setMessage(null);
		try {
			const result = await api.sessionOpV3(sessionId, { op: "skills-search", query: value.trim() });
			if (!("skillSearch" in result)) throw new Error("The registry did not return search results.");
			setSearchResult(result.skillSearch);
		} catch (cause) {
			setError(errorText(cause));
		} finally {
			setBusy(false);
		}
	}, [api, sessionId]);

	const mutate = useCallback(async (operation: { op: "skills-install"; specs: string[]; global: boolean } | { op: "skills-update"; names: string[]; global: boolean }): Promise<void> => {
		if (!sessionId || readOnly) return;
		operationController.current?.abort();
		const controller = new AbortController();
		const requestId = crypto.randomUUID();
		operationController.current = controller;
		setBusy(true);
		setMutating(true);
		setApprovalId(requestId);
		setPendingScriptApproval(null);
		setError(null);
		setMessage(null);
		try {
			const result = await api.sessionOpV3(sessionId, { ...operation, approvalId: requestId }, controller.signal);
			if (!("skillChanges" in result) || !("installedSkills" in result)) throw new Error("The session did not return the updated skill list.");
			setInstalled(result.installedSkills);
			setMessage([formatChanges(result.skillChanges), ...result.warnings].filter(Boolean).join("\n"));
			setTab("installed");
		} catch (cause) {
			if (!controller.signal.aborted) setError(errorText(cause));
		} finally {
			if (operationController.current === controller) {
				operationController.current = null;
				if (!controller.signal.aborted) {
					setBusy(false);
					setMutating(false);
					setApprovalId(null);
				}
			}
		}
	}, [api, readOnly, sessionId]);

	useEffect(() => {
		if (readOnly || !mutating || !sessionId || !approvalId) {
			setPendingScriptApproval(null);
			return;
		}
		let current = true;
		let timer = 0;
		const poll = async (): Promise<void> => {
			try {
				const result = await api.sessionOpV3(sessionId, { op: "ui-requests" });
				if (current && "uiRequests" in result) {
					setPendingScriptApproval(findSkillScriptApproval(result.uiRequests, approvalId));
				}
			} catch {
				// The install operation reports its own failure; this poll only lifts its approval inline.
			}
			if (current) timer = window.setTimeout(() => void poll(), 250);
		};
		void poll();
		return () => {
			current = false;
			window.clearTimeout(timer);
		};
	}, [api, approvalId, mutating, readOnly, sessionId]);

	const answerScriptApproval = useCallback(async (value: "Yes" | "No"): Promise<void> => {
		if (readOnly || !sessionId || !pendingScriptApproval) return;
		setAnsweringScriptApproval(true);
		setError(null);
		try {
			const result = await api.sessionOpV3(sessionId, { op: "ui-answer", reqId: pendingScriptApproval.reqId, value });
			if (!("ok" in result) || !result.ok) throw new Error("The script approval could not be answered.");
			setPendingScriptApproval(null);
		} catch (cause) {
			setError(errorText(cause));
		} finally {
			setAnsweringScriptApproval(false);
		}
	}, [api, pendingScriptApproval, readOnly, sessionId]);

	useEffect(() => {
		const request = command === "skills" ? parseSkillCommand(args) : { kind: "none" as const };
		switch (request.kind) {
			case "none":
				return;
			case "invalid":
				setError(request.message);
				return;
			case "search":
				setTab("search");
				setQuery(request.query);
				void search(request.query);
				return;
			case "installed":
				setTab("installed");
				void loadInstalled();
				return;
			case "install":
				setTab("search");
				setInstallSpec(request.specs.join(" "));
				setInstallGlobal(request.global);
				void mutate({ op: "skills-install", specs: request.specs, global: request.global });
				return;
			case "update":
				setTab("installed");
				void mutate({ op: "skills-update", names: request.names, global: request.global });
				return;
		}
	}, [args, command, loadInstalled, mutate, search]);

	const submitSearch = (event: { preventDefault(): void }): void => {
		event.preventDefault();
		void search(query);
	};
	const submitInstall = (event: { preventDefault(): void }): void => {
		event.preventDefault();
		const specs = installSpec.trim().split(/\s+/).filter(Boolean);
		if (specs.length === 0) {
			setError("Enter one or more @scope/name skill packages.");
			return;
		}
		void mutate({ op: "skills-install", specs, global: installGlobal });
	};

	return (
		<Sheet title="Skills" windowKind="skills" onClose={onClose}>
			<div className="sk-panel">
				<p className="sk-intro">Search, install and update registry skills for this session. Installing a package that ships install scripts needs your approval; the dialog lists the package files. Cancel to decline installation.</p>
				<div className="dk-segment" role="tablist" aria-label="Skill sections">
					<button type="button" role="tab" aria-selected={tab === "search"} data-on={tab === "search" ? "true" : "false"} className="dk-segment-btn" onClick={() => setTab("search")}>Search</button>
					<button type="button" role="tab" aria-selected={tab === "installed"} data-on={tab === "installed" ? "true" : "false"} className="dk-segment-btn" onClick={() => { setTab("installed"); void loadInstalled(); }}>Installed</button>
				</div>
				{sessionId === undefined ? <p className="dk-hint" role="status">Open a daemon session to manage its skills.</p> : null}
				{error ? <p className="sk-error" role="alert">{error}</p> : null}
				{pendingScriptApproval ? (
					<div className="sk-script-overlay">
						<section className="sk-script-confirm" role="alertdialog" aria-modal="true" aria-labelledby="sk-script-confirm-title">
							<h3 id="sk-script-confirm-title">Install skill with scripts?</h3>
							<p className="sk-script-detail">{pendingScriptApproval.title}</p>
							<div className="sk-script-actions">
								<button type="button" className="sh-btn" onClick={() => void answerScriptApproval("No")} disabled={answeringScriptApproval || readOnly}>Cancel install</button>
								<button type="button" className="sh-btn sh-btn-primary" onClick={() => void answerScriptApproval("Yes")} disabled={answeringScriptApproval || readOnly}>Install skill</button>
							</div>
						</section>
					</div>
				) : null}
				{message ? <p className="sk-message" role="status">{message}</p> : null}
				{tab === "search" ? (
					<>
						<form className="sk-search" onSubmit={submitSearch}>
							<label htmlFor="sk-query">Search the skill registry</label>
							<div><input id="sk-query" value={query} onChange={event => setQuery(event.currentTarget.value)} placeholder="code review" disabled={!sessionId || busy} /><button type="submit" className="sh-btn sh-btn-primary" disabled={!sessionId || busy || query.trim() === ""}>{busy ? "Searching…" : "Search"}</button></div>
						</form>
						<form className="sk-install" onSubmit={submitInstall}>
							<label htmlFor="sk-install-spec">Install package</label>
							<div><input id="sk-install-spec" value={installSpec} onChange={event => setInstallSpec(event.currentTarget.value)} placeholder="@scope/name[@range]" disabled={!sessionId || readOnly || busy} /><button type="submit" className="sh-btn" disabled={!sessionId || readOnly || busy || installSpec.trim() === ""}>Install</button></div>
							<label className="sk-global"><input type="checkbox" checked={installGlobal} onChange={event => setInstallGlobal(event.currentTarget.checked)} disabled={!sessionId || readOnly || busy} /> Install for this user</label>
						</form>
						{busy && searchResult === null ? <p className="dk-hint" role="status">Searching the registry…</p> : null}
						{searchResult ? <SearchResults result={searchResult} disabled={busy || readOnly} onInstall={hit => void mutate({ op: "skills-install", specs: [`@${hit.scope}/${hit.name}`], global: installGlobal })} /> : null}
					</>
				) : (
					<section className="sk-installed" aria-label="Installed skills">
						<div className="sk-installed-head"><h3>Installed skills</h3><button type="button" className="sh-btn" onClick={() => void loadInstalled()} disabled={!sessionId || busy}>Refresh</button></div>
						{busy && installed.length === 0 ? <p className="dk-hint" role="status">Loading installed skills…</p> : null}
						{installed.length === 0 && !busy ? <p className="dk-hint">No registry skills installed.</p> : null}
						{installed.map(skill => <article className="sk-item" key={`${skill.scope}:${skill.id}`}>
							<div><strong>{skill.id}</strong><span>{skill.version ?? "not installed"}{skill.range ? ` · ${skill.range}` : ""} · {skill.scope}</span>{skill.version && !skill.stored ? <em>Package missing from the local store</em> : null}</div>
							<button type="button" className="sh-btn" onClick={() => void mutate({ op: "skills-update", names: [skill.id], global: skill.scope === "user" })} disabled={!sessionId || readOnly || busy}>Update</button>
						</article>)}
					</section>
					)}
			</div>
		</Sheet>
	);
}

function SearchResults({ result, disabled, onInstall }: { result: SkillSearchResult; disabled: boolean; onInstall(hit: SkillSearchHit): void }): ReactNode {
	if (result.hits.length === 0) return <p className="dk-hint">No skills found.</p>;
	return <section className="sk-results" aria-label="Skill search results">
		{result.hits.map(hit => <article className="sk-item" key={`${hit.scope}/${hit.name}`}>
			<div><strong>{skillLabel(hit)} <small>{hit.version}</small></strong>{hit.description ? <p>{hit.description}</p> : null}<span>{hit.weeklyDownloads.toLocaleString()} weekly downloads · by {hit.publisher.username}{hit.keywords.length > 0 ? ` · ${hit.keywords.join(", ")}` : ""}</span>{hit.deprecated ? <em>Deprecated: {hit.deprecated}</em> : null}</div>
			<button type="button" className="sh-btn" onClick={() => onInstall(hit)} disabled={disabled}>Install</button>
		</article>)}
		{result.total > result.hits.length ? <p className="dk-hint">Showing {result.hits.length} of {result.total} results.</p> : null}
	</section>;
}
