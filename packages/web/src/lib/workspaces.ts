/**
 * Workspace helpers (grand-list 6): which workspace a session is in, how the panel groups them, and the rules-editor
 * rules (what is private, what is shared, which paths a new rule may take). Pure functions; the daemon does the real
 * validation again.
 */
import type { Workspace, WorkspaceKind, WorkspaceRuleFile } from "@omp-console/protocol";

function trimSlashes(path: string): string {
	return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/**
 * Longest-prefix match on a path boundary: `/a/b` owns `/a/b` and `/a/b/c` but not `/a/bc`.
 * A session started in a subdirectory of a workspace belongs to it.
 */
export function workspaceOf(workspaces: readonly Workspace[], cwd: string): Workspace | undefined {
	const target = trimSlashes(cwd);
	let best: Workspace | undefined;
	let bestLength = -1;
	for (const workspace of workspaces) {
		const root = trimSlashes(workspace.root);
		const inside = target === root || target.startsWith(root === "/" ? "/" : `${root}/`);
		if (inside && root.length > bestLength) {
			best = workspace;
			bestLength = root.length;
		}
	}
	return best;
}

export const KIND_ORDER: readonly WorkspaceKind[] = ["knowledge", "project", "scratch"];

export const KIND_LABEL: Record<WorkspaceKind, string> = {
	knowledge: "Knowledge",
	project: "Projects",
	scratch: "Scratch",
};

export interface WorkspaceGroup {
	kind: WorkspaceKind;
	label: string;
	workspaces: Workspace[];
}

/** Knowledge, projects (by name), scratch (by name); empty groups are dropped. */
export function groupWorkspaces(workspaces: readonly Workspace[]): WorkspaceGroup[] {
	return KIND_ORDER.flatMap(kind => {
		const inKind = workspaces.filter(w => w.kind === kind).sort((a, b) => a.name.localeCompare(b.name));
		return inKind.length === 0 ? [] : [{ kind, label: KIND_LABEL[kind], workspaces: inKind }];
	});
}

/** One-line git status for a row: `main · 3 ahead · dirty`. */
export function gitSummary(git: Workspace["git"]): string {
	if (git === undefined) return "not a git repo";
	const parts: string[] = [git.branch ?? "detached"];
	if (git.ahead) parts.push(`${git.ahead} ahead`);
	if (git.behind) parts.push(`${git.behind} behind`);
	parts.push(git.dirty ? "dirty" : "clean");
	return parts.join(" · ");
}

// ---- rules editor -------------------------------------------------------------------------------------

export type RuleVisibility = WorkspaceRuleFile["visibility"];

export interface VisibilityNote {
	label: string;
	/** Who sees the file. */
	audience: string;
	/** Where deck writes it and what happens to git. */
	storage: string;
}

export const VISIBILITY_NOTES: Record<RuleVisibility, VisibilityNote> = {
	private: {
		label: "Private",
		audience: "Only you and your agents on this Mac. Coworkers never see it.",
		storage: "Saved under .omp/rules/ and listed in .git/info/exclude, so git status stays clean.",
	},
	shared: {
		label: "Shared",
		audience: "Everyone who clones the repo, once you commit it.",
		storage: "Saved as a plain file (AGENTS.md or docs/). omp console shows the git diff and never commits.",
	},
};

export const PRIVATE_RULES_DIR = ".omp/rules/";

export type PathCheck = { ok: true; path: string } | { ok: false; message: string };

/** Mirrors the daemon's path rules: relative, no `..`, no empty or dot segments, `.md`/`.mdc`. */
export function validateRulePath(raw: string): PathCheck {
	const path = raw.trim();
	if (path === "") return { ok: false, message: "Enter a file path." };
	if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return { ok: false, message: "The path must be relative to the workspace." };
	if (path.includes("\\") || path.includes("\0")) return { ok: false, message: "Use forward slashes and plain characters only." };
	const segments = path.split("/");
	if (segments.some(s => s === "" || s === "." || s === "..")) {
		return { ok: false, message: "No empty, . or .. segments." };
	}
	if (!/\.(md|mdc)$/.test(path) || (segments[segments.length - 1] ?? "").replace(/\.(md|mdc)$/, "") === "") {
		return { ok: false, message: "Rule files are named something.md or something.mdc." };
	}
	return { ok: true, path };
}

/** A new file must live where its visibility says: private under `.omp/rules/`, shared as `AGENTS.md` or under `docs/`. */
export function validateNewRulePath(visibility: RuleVisibility, raw: string): PathCheck {
	const base = validateRulePath(raw);
	if (!base.ok) return base;
	if (visibility === "private") {
		return base.path.startsWith(PRIVATE_RULES_DIR) && base.path.length > PRIVATE_RULES_DIR.length
			? base
			: { ok: false, message: `Private rules live under ${PRIVATE_RULES_DIR}` };
	}
	return base.path === "AGENTS.md" || base.path.startsWith("docs/")
		? base
		: { ok: false, message: "Shared rules are AGENTS.md or files under docs/." };
}

/** A starting path for the "new rule file" form. */
export function suggestedRulePath(visibility: RuleVisibility, name: string): string {
	const slug = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (visibility === "private") return `${PRIVATE_RULES_DIR}${slug || "notes"}.md`;
	return slug === "" || slug === "agents" ? "AGENTS.md" : `docs/${slug}.md`;
}

export interface RuleListEntry {
	path: string;
	visibility: RuleVisibility;
}

/** Private files first, then shared; each group alphabetical. */
export function sortedRules(rules: readonly WorkspaceRuleFile[]): RuleListEntry[] {
	const rank = (v: RuleVisibility): number => (v === "private" ? 0 : 1);
	return [...rules].sort((a, b) => rank(a.visibility) - rank(b.visibility) || a.path.localeCompare(b.path));
}

export function ruleCounts(rules: readonly WorkspaceRuleFile[]): { private: number; shared: number } {
	const privateCount = rules.filter(r => r.visibility === "private").length;
	return { private: privateCount, shared: rules.length - privateCount };
}

export interface RuleDraft {
	path: string;
	visibility: RuleVisibility;
	/** Content as last loaded or saved; null for a file that does not exist yet. */
	saved: string | null;
	content: string;
	isNew: boolean;
}

/** `.omp/rules/*` files are omp rules; others (AGENTS.md, docs) are context files that always load. */
export function isOmpRulePath(path: string): boolean {
	return /(^|\/)\.omp\/rules\//.test(path);
}

/** New omp rule files start applied to every session; changing it to `description: …` makes it load on demand. */
export const RULE_TEMPLATE = "---\nalwaysApply: true\n---\n\n";

function splitFrontmatter(content: string): { front: string; body: string } {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
	return match ? { front: match[1]!, body: content.slice(match[0].length) } : { front: "", body: content };
}

/**
 * How omp will use a rule file (capability/rule-buckets.ts): `always` (alwaysApply), `on-demand` (has a description,
 * listed in the rulebook), `conditional` (TTSR condition), `ignored` (none of them: omp drops it), `context` (not a
 * rule file).
 */
export type RuleActivation = "always" | "on-demand" | "conditional" | "ignored" | "context";

export function ruleActivation(path: string, content: string): RuleActivation {
	if (!isOmpRulePath(path)) return "context";
	const { front } = splitFrontmatter(content);
	if (/^alwaysApply:\s*true\s*$/m.test(front)) return "always";
	if (/^(condition|astCondition|question):\s*\S/m.test(front)) return "conditional";
	if (/^description:\s*\S/m.test(front)) return "on-demand";
	return "ignored";
}

export function ruleDirty(draft: RuleDraft): boolean {
	return draft.isNew ? splitFrontmatter(draft.content).body.trim() !== "" : draft.content !== draft.saved;
}

/** Save is possible when there is something to write and, for a new file, its path is valid for its visibility. */
export function ruleSaveBlocker(draft: RuleDraft): string | null {
	if (draft.isNew) {
		const check = validateNewRulePath(draft.visibility, draft.path);
		if (!check.ok) return check.message;
		if (splitFrontmatter(draft.content).body.trim() === "") return "Write something first.";
		return null;
	}
	return ruleDirty(draft) ? null : "No changes.";
}

/** The diff is only meaningful for shared files; private files are not tracked by git. */
export function showsDiff(visibility: RuleVisibility, diff: string | undefined): boolean {
	return visibility === "shared" && diff !== undefined && diff.trim() !== "";
}

export type DiffLineKind = "add" | "del" | "hunk" | "meta" | "ctx";

export interface DiffLine {
	kind: DiffLineKind;
	text: string;
}

/** Classifies unified-diff lines for colouring; no HTML, the renderer escapes via React. */
export function parseDiff(diff: string): DiffLine[] {
	return diff
		.replace(/\n$/, "")
		.split("\n")
		.map(text => {
			let kind: DiffLineKind = "ctx";
			if (text.startsWith("+++") || text.startsWith("---") || text.startsWith("diff ") || text.startsWith("index ")) kind = "meta";
			else if (text.startsWith("@@")) kind = "hunk";
			else if (text.startsWith("+")) kind = "add";
			else if (text.startsWith("-")) kind = "del";
			return { kind, text };
		});
}
