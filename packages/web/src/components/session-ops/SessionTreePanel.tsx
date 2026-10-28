import type { CreateSessionRequest, SessionSummary, SessionTreeNode } from "@omp-console/protocol";
import { GitBranch, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import type { DeckApi } from "../../lib/api";
import { runSessionOp, sessionOpError, treeFromResult } from "../../lib/session-ops";
import { recordUsage } from "../../lib/journal";
import { OmpEquivalent } from "../catalog/OmpEquivalent";

export interface SessionTreeRow {
	node: SessionTreeNode;
	depth: number;
}

/**
 * Rows for the tree view. Only conversation entries are shown (user messages and assistant replies with text); the
 * entries between them (tool events, model changes, bookkeeping) are walked through but not listed. Depth grows only
 * at real branch points, so a linear conversation reads as a flat list and each fork is one indent.
 */
export function flattenSessionTree(nodes: readonly SessionTreeNode[]): SessionTreeRow[] {
	const byId = new Map(nodes.map(node => [node.entryId, node]));
	const children = new Map<string, SessionTreeNode[]>();
	const roots: SessionTreeNode[] = [];
	for (const node of nodes) {
		if (node.parentId === null || !byId.has(node.parentId)) {
			roots.push(node);
			continue;
		}
		const siblings = children.get(node.parentId) ?? [];
		siblings.push(node);
		children.set(node.parentId, siblings);
	}
	const visible = (node: SessionTreeNode): boolean =>
		node.role === "user" || (node.role === "assistant" && node.preview.trim() !== "");
	const result: SessionTreeRow[] = [];
	const seen = new Set<string>();
	const stack = roots.slice().reverse().map(node => ({ node, depth: 0 }));
	while (stack.length > 0) {
		const row = stack.pop()!;
		if (seen.has(row.node.entryId)) continue;
		seen.add(row.node.entryId);
		if (visible(row.node)) result.push(row);
		const descendants = children.get(row.node.entryId) ?? [];
		const childDepth = row.depth + (descendants.length > 1 ? 1 : 0);
		for (let i = descendants.length - 1; i >= 0; i--) stack.push({ node: descendants[i]!, depth: childDepth });
	}
	for (const node of nodes) if (!seen.has(node.entryId) && visible(node)) result.push({ node, depth: 0 });
	return result;
}

export function forkRequestForEntry(summary: SessionSummary | undefined, entryId: string): CreateSessionRequest | null {
	if (!summary?.sessionFile) return null;
	return { cwd: summary.cwd, forkFrom: { sessionFile: summary.sessionFile, entryId } };
}

export interface SessionTreePanelProps {
	api: DeckApi;
	sessionId: string | null;
	summary?: SessionSummary;
	onFork(request: CreateSessionRequest): Promise<void> | void;
}

export function SessionTreePanel({ api, sessionId, summary, onFork }: SessionTreePanelProps): ReactNode {
	const [tree, setTree] = useState<SessionTreeNode[] | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [forking, setForking] = useState<string | null>(null);

	const load = useCallback(async (journalAction?: string): Promise<void> => {
		if (!sessionId) return;
		setLoading(true);
		setError(null);
		try {
			const result = journalAction
				? await runSessionOp(api, sessionId, { op: "tree" }, { feature: "1.11.tree", action: journalAction, screen: "status" })
				: await api.sessionOp(sessionId, { op: "tree" });
			setTree(treeFromResult(result));
		} catch (cause) {
			setError(sessionOpError(cause));
		} finally {
			setLoading(false);
		}
	}, [api, sessionId]);

	useEffect(() => {
		setTree(null);
		void load("load");
	}, [load]);

	const fork = async (entryId: string): Promise<void> => {
		const request = forkRequestForEntry(summary, entryId);
		if (!request || !sessionId || forking !== null) return;
		setForking(entryId);
		setError(null);
		try {
			await onFork(request);
			recordUsage({ feature: "1.11.tree", action: "fork", outcome: "ok", via: "direct", screen: "status", sessionId });
		} catch (cause) {
			recordUsage({ feature: "1.11.tree", action: "fork", outcome: "error", via: "direct", screen: "status", sessionId });
			setError(sessionOpError(cause));
		} finally {
			setForking(null);
		}
	};

	const rows = tree === null ? [] : flattenSessionTree(tree);
	return (
		<section className="dk-status-section so-section" aria-label="session tree">
			<h3 className="dk-section-title"><GitBranch size={15} />Session tree</h3>
			{tree === null ? (
				<p className="dk-hint">{sessionId ? "Load the session entries and branches." : "Open a session to inspect its tree."}</p>
			) : rows.length === 0 ? (
				<p className="dk-hint">No session entries were reported.</p>
			) : (
				<ol className="so-tree" role="tree">
					{rows.map(({ node, depth }) => {
						// A prompt forks just before itself (try a different prompt from there); a reply forks after itself.
						const target = node.forkEntryId;
						const before = target !== undefined && target !== node.entryId;
						const label = before ? "Fork before this" : "Fork from here";
						const title = !summary?.sessionFile
							? "This session has no saved file to fork"
							: target === undefined
								? "Nothing earlier to keep: start a new session instead"
								: before
									? "New session with everything before this message"
									: "New session with everything up to and including this message";
						return (
							<li key={node.entryId} role="treeitem" aria-level={depth + 1} aria-current={node.onCurrentBranch ? "true" : undefined} data-current={node.onCurrentBranch ? "true" : "false"} style={{ paddingInlineStart: `${depth * 16}px` }}>
								<div className="so-tree-row">
									<div className="so-tree-copy"><span className="so-tree-role">{node.role}{node.onCurrentBranch ? " · current branch" : " · branch"}</span><span className="so-tree-preview">{node.preview}</span></div>
									<button type="button" className="dk-wide-btn so-secondary" disabled={!sessionId || !summary?.sessionFile || target === undefined || forking !== null} title={title} onClick={() => target !== undefined && void fork(target)}>{forking === target ? "Forking…" : label}</button>
								</div>
							</li>
						);
					})}
				</ol>
			)}
			{sessionId && <button type="button" className="dk-wide-btn so-secondary" disabled={loading} onClick={() => void load("refresh")}><RefreshCw size={14} />{loading ? "Loading…" : tree === null ? "Load tree" : "Refresh tree"}</button>}
			<OmpEquivalent text="/tree" hint="Browse branches; fork from an entry is omp-console-only" actionId="1.11.tree" />
			{error && <p className="so-error" role="alert">{error}</p>}
		</section>
	);
}
