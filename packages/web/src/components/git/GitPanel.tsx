import type { GitChangedFile, GitFileDiff, GitStatusSnapshot } from "@omp-console/protocol";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import type { DeckApi } from "../../lib/api";
import { Sheet } from "../shell/Sheet";
import "./git.css";

export interface GitPanelProps {
	api: Pick<DeckApi, "sessionOpV3">;
	sessionId: string | undefined;
	readOnly: boolean;
	command?: string;
	args?: string;
	onClose(): void;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function filesIn(snapshot: GitStatusSnapshot): GitChangedFile[] {
	return [...snapshot.unstaged, ...snapshot.staged, ...snapshot.commitFiles];
}

function selectNext(snapshot: GitStatusSnapshot, previous: GitChangedFile | null): GitChangedFile | null {
	const files = filesIn(snapshot);
	if (previous) {
		const matching = files.find(file => file.path === previous.path && file.area === previous.area) ?? files.find(file => file.path === previous.path);
		if (matching) return matching;
	}
	return files[0] ?? null;
}

function displayBytes(byteLength: number | undefined): string {
	if (byteLength === undefined) return "";
	return ` · ${new Intl.NumberFormat().format(byteLength)} bytes`;
}

function AssetSide({ side, label }: { side: Extract<GitFileDiff, { kind: "asset" }>["old"]; label: string }): ReactNode {
	if (side.kind === "image" && side.image) {
		return <figure className="git-image"><img src={`data:${side.image.mimeType};base64,${side.image.data}`} alt={`${label} image`} /><figcaption>{side.image.sourceMimeType}{displayBytes(side.image.byteLength)}</figcaption></figure>;
	}
	if (side.kind === "empty") return <p className="dk-hint">{label}: empty</p>;
	return <p className="dk-hint">{label}: {side.kind}{displayBytes(side.byteLength)}{side.oid ? ` · LFS ${side.oid}` : ""}</p>;
}
export interface GitDiffViewProps {
	diff: Extract<GitFileDiff, { kind: "text" }>;
	selectedArea: GitChangedFile["area"] | null;
	readOnly: boolean;
	revisionMode: boolean;
	busy: boolean;
	onApplyHunk(hunkIndex: number, patchHash: string): void;
}

export function GitDiffView({ diff, selectedArea, readOnly, revisionMode, busy, onApplyHunk }: GitDiffViewProps): ReactNode {
	return <div className="git-diff" aria-label="Unified diff">
		{diff.hunks.length === 0 ? <p className="dk-hint">No changes in this diff.</p> : diff.hunks.map((hunk, index) => (
			<section className="git-diff-hunk" aria-label={`Hunk ${index + 1}`} key={`${index}:${hunk.patchHash}`}>
				<div className="git-diff-hunk-head">
					<code>{hunk.header}</code>
					{selectedArea !== null && !readOnly && !revisionMode && selectedArea !== "commit" && diff.canPatch
						? <button type="button" className="sh-btn" onClick={() => onApplyHunk(index, hunk.patchHash)} disabled={busy}>{selectedArea === "unstaged" ? `Stage hunk ${index + 1}` : `Unstage hunk ${index + 1}`}</button>
						: null}
				</div>
				<pre className="git-diff-lines">{hunk.lines.map((line, lineIndex) => <span className="git-diff-line" data-kind={line.kind} key={`${index}:${lineIndex}`}>{line.text}{"\n"}</span>)}</pre>
			</section>
		))}
	</div>;
}

export function GitPanel({ api, sessionId, readOnly, command, args, onClose }: GitPanelProps): ReactNode {
	const [revision, setRevision] = useState(args?.trim() ?? "");
	const [revisionDraft, setRevisionDraft] = useState(args?.trim() ?? "");
	const [view, setView] = useState<GitStatusSnapshot | null>(null);
	const [selected, setSelected] = useState<GitChangedFile | null>(null);
	const [diff, setDiff] = useState<GitFileDiff | null>(null);
	const [diffVersion, setDiffVersion] = useState(0);
	const [loading, setLoading] = useState(false);
	const [diffLoading, setDiffLoading] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [commitMessage, setCommitMessage] = useState("");

	useEffect(() => {
		const next = command === "git" ? args?.trim() ?? "" : "";
		setRevision(next);
		setRevisionDraft(next);
	}, [args, command]);

	const load = useCallback(async (): Promise<GitStatusSnapshot | null> => {
		if (!sessionId) return null;
		setLoading(true);
		setError(null);
		try {
			const result = await api.sessionOpV3(sessionId, revision ? { op: "git-view", revision } : { op: "git-view" });
			if (!("git" in result)) throw new Error("The session did not return Git state.");
			setView(result.git);
			setSelected(current => selectNext(result.git, current));
			return result.git;
		} catch (cause) {
			setError(errorText(cause));
			setView(null);
			setSelected(null);
			return null;
		} finally {
			setLoading(false);
		}
	}, [api, revision, sessionId]);

	useEffect(() => {
		void load();
	}, [load]);

	const selectedPath = selected?.path;
	const selectedArea = selected?.area;
	useEffect(() => {
		if (!sessionId || !selectedPath || !selectedArea) {
			setDiff(null);
			return;
		}
		let current = true;
		setDiffLoading(true);
		setError(null);
		const operation = revision
			? { op: "git-diff" as const, path: selectedPath, area: selectedArea, revision }
			: { op: "git-diff" as const, path: selectedPath, area: selectedArea };
		void api.sessionOpV3(sessionId, operation).then(result => {
			if (!current) return;
			if (!("gitDiff" in result)) throw new Error("The session did not return the selected diff.");
			setDiff(result.gitDiff);
		}).catch(cause => {
			if (current) {
				setDiff(null);
				setError(errorText(cause));
			}
		}).finally(() => {
			if (current) setDiffLoading(false);
		});
		return () => {
			current = false;
		};
	}, [api, diffVersion, revision, selectedArea, selectedPath, sessionId]);

	const applyRevision = (event: { preventDefault(): void }): void => {
		event.preventDefault();
		setRevision(revisionDraft.trim());
	};

	const stage = async (action: "stage" | "unstage"): Promise<void> => {
		if (!sessionId || !selected || readOnly || selected.area === "commit") return;
		setBusy(true);
		setError(null);
		try {
			const result = await api.sessionOpV3(sessionId, { op: "git-stage", action, paths: [selected.path] });
			if (!("git" in result)) throw new Error("The session did not return Git state.");
			setView(result.git);
			setSelected(current => selectNext(result.git, current));
			setDiffVersion(version => version + 1);
		} catch (cause) {
			setError(errorText(cause));
		} finally {
			setBusy(false);
		}
	};
	const applyHunk = async (hunkIndex: number, patchHash: string): Promise<void> => {
		if (!sessionId || !selected || readOnly || (selected.area !== "unstaged" && selected.area !== "staged")) return;
		const area = selected.area;
		const action = area === "unstaged" ? "stage" : "unstage";
		setBusy(true);
		setError(null);
		try {
			const result = await api.sessionOpV3(sessionId, { op: "git-hunk", action, path: selected.path, area, hunkIndex, patchHash });
			if (!("git" in result)) throw new Error("The session did not return Git state.");
			setView(result.git);
			setSelected(current => selectNext(result.git, current));
			setDiffVersion(version => version + 1);
		} catch (cause) {
			setError(errorText(cause));
		} finally {
			setBusy(false);
		}
	};
	const commit = async (event: { preventDefault(): void }): Promise<void> => {
		event.preventDefault();
		if (!sessionId || readOnly || view?.readOnly || commitMessage.trim() === "") return;
		setBusy(true);
		setError(null);
		try {
			const result = await api.sessionOpV3(sessionId, { op: "git-commit", message: commitMessage });
			if (!("git" in result)) throw new Error("The session did not return Git state.");
			setView(result.git);
			setSelected(current => selectNext(result.git, current));
			setDiffVersion(version => version + 1);
			setCommitMessage("");
		} catch (cause) {
			setError(errorText(cause));
		} finally {
			setBusy(false);
		}
	};

	const revisionMode = view?.readOnly === true;
	return (
		<Sheet title="Git" windowKind="git" onClose={onClose}>
			<div className="git-panel">
				<form className="git-revision" onSubmit={applyRevision}>
					<label htmlFor="git-revision-input">Revision view</label>
					<div><input id="git-revision-input" value={revisionDraft} onChange={event => setRevisionDraft(event.currentTarget.value)} placeholder="HEAD~1" disabled={!sessionId || busy} /><button type="submit" className="sh-btn" disabled={!sessionId || busy}>{revisionMode ? "View revision" : "Open revision"}</button>{revisionMode ? <button type="button" className="sh-btn" onClick={() => { setRevisionDraft(""); setRevision(""); }} disabled={busy}>Working tree</button> : null}</div>
				</form>
				{sessionId === undefined ? <p className="dk-hint" role="status">Open a daemon session to inspect its repository.</p> : null}
				{error ? <p className="git-error" role="alert">{error}</p> : null}
				{loading && view === null ? <p className="dk-hint" role="status">Loading Git state…</p> : null}
				{view ? <>
					<div className="git-summary"><strong>{view.branch ?? (view.readOnly ? "Revision" : "Detached HEAD")}</strong>{view.headCommit ? <span>{view.headCommit.shortSha} · {view.headCommit.subject}</span> : null}{view.readOnly ? <span>Read-only revision {view.revision}</span> : null}</div>
					<div className="git-body">
						<nav className="git-files" aria-label="Changed files">
							{view.unstaged.length > 0 ? <FileGroup label="Unstaged" files={view.unstaged} selected={selected} onSelect={setSelected} /> : null}
							{view.staged.length > 0 ? <FileGroup label="Staged" files={view.staged} selected={selected} onSelect={setSelected} /> : null}
							{view.commitFiles.length > 0 ? <FileGroup label={view.readOnly ? "Revision files" : "HEAD commit"} files={view.commitFiles} selected={selected} onSelect={setSelected} /> : null}
							{filesIn(view).length === 0 ? <p className="dk-hint">No changed files.</p> : null}
						</nav>
						<section className="git-detail" aria-label="Selected file diff">
							{selected ? <div className="git-detail-head"><strong>{selected.path}</strong><span>{selected.kind}{selected.additions === undefined ? "" : ` · +${selected.additions}/−${selected.deletions ?? 0}`}</span></div> : <p className="dk-hint">Select a file to inspect its contents.</p>}
							{diffLoading ? <p className="dk-hint" role="status">Loading file contents…</p> : null}
							{diff?.kind === "text" ? <GitDiffView diff={diff} selectedArea={selected?.area ?? null} readOnly={readOnly} revisionMode={revisionMode} busy={busy} onApplyHunk={(index, patchHash) => void applyHunk(index, patchHash)} /> : null}
							{diff?.kind === "asset" ? <div className="git-split"><section><h3>Before</h3><AssetSide side={diff.old} label="Before" /></section><section><h3>After</h3><AssetSide side={diff.new} label="After" /></section></div> : null}
							{selected && !readOnly && !revisionMode ? <div className="git-actions">
								{selected.area === "unstaged" ? <button type="button" className="sh-btn" onClick={() => void stage("stage")} disabled={busy}>Stage file</button> : null}
								{selected.area === "staged" ? <button type="button" className="sh-btn" onClick={() => void stage("unstage")} disabled={busy}>Unstage file</button> : null}
							</div> : null}
						</section>
					</div>
					{!readOnly && !revisionMode && view.staged.length > 0 ? <form className="git-commit" onSubmit={event => void commit(event)}>
						<label htmlFor="git-commit-message">Commit staged files locally</label>
						<div><input id="git-commit-message" value={commitMessage} onChange={event => setCommitMessage(event.currentTarget.value)} placeholder="Commit message" disabled={busy} /><button type="submit" className="sh-btn sh-btn-primary" disabled={busy || commitMessage.trim() === ""}>{busy ? "Committing…" : "Commit"}</button></div>
						<p>Local commit only. omp console never pushes.</p>
					</form> : null}
				</> : null}
			</div>
		</Sheet>
	);
}

function FileGroup({ label, files, selected, onSelect }: { label: string; files: GitChangedFile[]; selected: GitChangedFile | null; onSelect(file: GitChangedFile): void }): ReactNode {
	return <section className="git-file-group" aria-label={label}>
		<h3>{label}</h3>
		{files.map(file => <button type="button" key={`${file.area}:${file.path}`} className="git-file" data-selected={selected?.area === file.area && selected.path === file.path ? "true" : "false"} onClick={() => onSelect(file)}>
			<span>{file.path}</span><small>{file.kind}{file.additions === undefined ? "" : ` · +${file.additions}/−${file.deletions ?? 0}`}</small>
		</button>)}
	</section>;
}
