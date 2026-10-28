import type { Workspace } from "@omp-console/protocol";
import { ArrowLeft, EyeOff, FilePlus, Lock, Save, Users } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { DeckApi } from "../../lib/api";
import { shortenPath } from "../../lib/format";
import { recordUsage } from "../../lib/journal";
import {
	isOmpRulePath,
	parseDiff,
	RULE_TEMPLATE,
	type RuleActivation,
	ruleActivation,
	type RuleDraft,
	type RuleVisibility,
	ruleCounts,
	ruleDirty,
	ruleSaveBlocker,
	showsDiff,
	sortedRules,
	suggestedRulePath,
	VISIBILITY_NOTES,
} from "../../lib/workspaces";
import { OmpEquivalent } from "../catalog/OmpEquivalent";

type RulesApi = Pick<DeckApi, "readRuleFile" | "writeRuleFile">;

export interface RulesEditorProps {
	api: RulesApi;
	workspace: Workspace;
	onBack(): void;
	/** Called after a write so the workspace list (rule files, git state) is reloaded. */
	onSaved(): void;
}

interface Loaded {
	path: string;
	visibility: RuleVisibility;
	saved: string | null;
	diff: string | undefined;
}

function VisibilityIcon({ visibility }: { visibility: RuleVisibility }): ReactNode {
	return visibility === "private" ? <Lock size={11} /> : <Users size={11} />;
}

export function RulesEditor({ api, workspace, onBack, onSaved }: RulesEditorProps): ReactNode {
	const rules = useMemo(() => sortedRules(workspace.rules), [workspace.rules]);
	const counts = ruleCounts(workspace.rules);
	const [draft, setDraft] = useState<RuleDraft | null>(null);
	const [loaded, setLoaded] = useState<Loaded | null>(null);
	const [diffOpen, setDiffOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [creating, setCreating] = useState<{ visibility: RuleVisibility; name: string } | null>(null);

	const open = useCallback(
		async (path: string, visibility: RuleVisibility): Promise<void> => {
			setBusy(true);
			setError(null);
			setDiffOpen(false);
			try {
				const file = await api.readRuleFile(workspace.id, path);
				setLoaded({ path: file.path, visibility: file.visibility, saved: file.content, diff: file.diff });
				setDraft({ path: file.path, visibility: file.visibility, saved: file.content, content: file.content, isNew: false });
			} catch (err) {
				setError(err instanceof Error ? err.message : "could not read the file");
				setLoaded({ path, visibility, saved: null, diff: undefined });
				setDraft(null);
			} finally {
				setBusy(false);
			}
		},
		[api, workspace.id],
	);

	// Switching workspace drops the open file.
	useEffect(() => {
		setDraft(null);
		setLoaded(null);
		setCreating(null);
		setError(null);
	}, [workspace.id]);

	const startCreate = (): void => {
		setDraft(null);
		setLoaded(null);
		setCreating({ visibility: "private", name: "" });
		setError(null);
	};

	const confirmCreate = (): void => {
		if (!creating) return;
		const path = suggestedRulePath(creating.visibility, creating.name);
		setDraft({ path, visibility: creating.visibility, saved: null, content: isOmpRulePath(path) ? RULE_TEMPLATE : "", isNew: true });
		setLoaded({ path, visibility: creating.visibility, saved: null, diff: undefined });
		setCreating(null);
	};

	const blocker = draft === null ? null : ruleSaveBlocker(draft);

	const save = async (): Promise<void> => {
		if (draft === null || blocker !== null) return;
		setBusy(true);
		setError(null);
		try {
			await api.writeRuleFile(workspace.id, draft.path, { visibility: draft.visibility, content: draft.content });
			recordUsage({
				feature: "6.rules",
				action: draft.isNew ? "create" : "save",
				outcome: "ok",
				via: "direct",
				screen: "workspaces",
				detail: draft.visibility,
			});
			onSaved();
			await open(draft.path, draft.visibility);
		} catch (err) {
			recordUsage({ feature: "6.rules", action: "save", outcome: "error", via: "direct", screen: "workspaces", detail: draft.visibility });
			setError(err instanceof Error ? err.message : "could not save");
			setBusy(false);
		}
	};

	return (
		<div className="ws-rules">
			<div className="ws-rules-head">
				<button type="button" className="sh-btn sh-btn-icon" onClick={onBack} aria-label="back to workspaces" title="back">
					<ArrowLeft size={15} />
				</button>
				<div className="ws-rules-title">
					<strong>{workspace.name}</strong>
					<span className="ws-muted">
						{counts.private} private · {counts.shared} shared
					</span>
				</div>
				<button type="button" className="sh-btn" onClick={startCreate} disabled={busy}>
					<FilePlus size={13} /> New file
				</button>
			</div>

			<div className="ws-visibility-cards" aria-label="who sees what">
				{(["private", "shared"] as const).map(visibility => (
					<div key={visibility} className="ws-vis-card" data-visibility={visibility}>
						<div className="ws-vis-title">
							<VisibilityIcon visibility={visibility} />
							{VISIBILITY_NOTES[visibility].label}
						</div>
						<p>{VISIBILITY_NOTES[visibility].audience}</p>
						<p className="ws-muted">{VISIBILITY_NOTES[visibility].storage}</p>
					</div>
				))}
			</div>

			{rules.length === 0 && !creating && !draft && <div className="ws-empty">No rule files yet. Create one to give agents here standing instructions.</div>}
			<ul className="ws-rule-list">
				{rules.map(rule => (
					<li key={rule.path}>
						<button
							type="button"
							className="ws-rule-row"
							data-selected={draft?.path === rule.path ? "true" : "false"}
							onClick={() => void open(rule.path, rule.visibility)}
						>
							<span className="ws-vis-badge" data-visibility={rule.visibility}>
								<VisibilityIcon visibility={rule.visibility} />
								{rule.visibility}
							</span>
							<code>{rule.path}</code>
						</button>
					</li>
				))}
			</ul>

			{creating && (
				<form
					className="ws-new-rule"
					onSubmit={event => {
						event.preventDefault();
						confirmCreate();
					}}
				>
					<div className="dk-segment ws-segment-2" role="radiogroup" aria-label="new rule visibility">
						{(["private", "shared"] as const).map(visibility => (
							<button
								key={visibility}
								type="button"
								role="radio"
								aria-checked={creating.visibility === visibility}
								className="dk-segment-btn"
								data-on={creating.visibility === visibility ? "true" : "false"}
								onClick={() => setCreating({ ...creating, visibility })}
							>
								<VisibilityIcon visibility={visibility} />
								{VISIBILITY_NOTES[visibility].label}
							</button>
						))}
					</div>
					<label className="sh-field">
						<span className="sh-field-label">Name</span>
						<input
							className="sh-input"
							value={creating.name}
							onChange={event => setCreating({ ...creating, name: event.target.value })}
							placeholder={creating.visibility === "private" ? "testing" : "AGENTS or a docs name"}
							spellCheck={false}
							autoComplete="off"
							autoFocus
						/>
						<span className="sh-field-hint">
							Will be <code>{suggestedRulePath(creating.visibility, creating.name)}</code>
						</span>
					</label>
					<div className="ws-row-actions">
						<button type="submit" className="sh-btn sh-btn-primary">
							Start file
						</button>
						<button type="button" className="sh-btn" onClick={() => setCreating(null)}>
							Cancel
						</button>
					</div>
				</form>
			)}

			{error && (
				<div className="dk-notice dk-notice-err ws-notice" role="alert">
					<span>{error}</span>
				</div>
			)}

			{draft && loaded && (
				<div className="ws-editor" data-visibility={draft.visibility}>
					<div className="ws-editor-head">
						<span className="ws-vis-badge" data-visibility={draft.visibility}>
							<VisibilityIcon visibility={draft.visibility} />
							{draft.visibility}
						</span>
						<code>{draft.path}</code>
						{ruleDirty(draft) && <span className="ws-dirty">unsaved</span>}
					</div>
					<textarea
						className="ws-editor-text"
						value={draft.content}
						onChange={event => setDraft({ ...draft, content: event.target.value })}
						spellCheck={false}
						aria-label={`edit ${draft.path}`}
						disabled={busy}
					/>
					<RuleActivationNote path={draft.path} content={draft.content} />
					<div className="ws-row-actions">
						<button type="button" className="sh-btn sh-btn-primary" onClick={() => void save()} disabled={busy || blocker !== null} title={blocker ?? "save"}>
							<Save size={13} /> Save
						</button>
						{showsDiff(draft.visibility, loaded.diff) && (
							<button type="button" className="sh-btn" onClick={() => setDiffOpen(open => !open)} aria-expanded={diffOpen}>
								{diffOpen ? "Hide diff" : "Diff vs HEAD"}
							</button>
						)}
						{blocker !== null && ruleDirty(draft) && <span className="ws-muted">{blocker}</span>}
					</div>
					{draft.visibility === "private" && (
						<p className="ws-muted ws-privnote">
							<EyeOff size={11} /> Not tracked by git: listed in .git/info/exclude.
						</p>
					)}
					{draft.visibility === "shared" && (
						<p className="ws-muted ws-privnote">
							<Users size={11} /> omp console never commits. Review the diff, then commit it yourself.
						</p>
					)}
					{diffOpen && loaded.diff !== undefined && (
						<pre className="ws-diff" aria-label="git diff">
							{parseDiff(loaded.diff).map((line, index) => (
								<span key={index} className="ws-diff-line" data-kind={line.kind}>
									{line.text}
									{"\n"}
								</span>
							))}
						</pre>
					)}
				</div>
			)}

			<OmpEquivalent text={`$EDITOR ${shortenPath(workspace.root)}/AGENTS.md`} actionId="workspace.rules" />
		</div>
	);
}

const ACTIVATION_TEXT: Record<Exclude<RuleActivation, "context">, string> = {
	always: "omp adds this rule to every session here (alwaysApply: true).",
	"on-demand": "omp lists this rule by its description and reads it when relevant.",
	conditional: "omp injects this rule when its condition matches.",
	ignored: "omp ignores this file: add `alwaysApply: true` or a `description:` line in the --- header at the top.",
};

/** Says how omp will treat the rule file as it is written now, so a file omp would drop is never saved silently. */
function RuleActivationNote({ path, content }: { path: string; content: string }): ReactNode {
	const activation = ruleActivation(path, content);
	if (activation === "context") return null;
	return (
		<p className={activation === "ignored" ? "sf-slug-error" : "ws-muted"} role={activation === "ignored" ? "alert" : undefined}>
			{ACTIVATION_TEXT[activation]}
		</p>
	);
}
