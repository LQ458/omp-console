import { describe, expect, it } from "bun:test";
import type { Workspace } from "@omp-console/protocol";
import {
	groupWorkspaces,
	parseDiff,
	RULE_TEMPLATE,
	ruleActivation,
	type RuleDraft,
	ruleCounts,
	ruleDirty,
	ruleSaveBlocker,
	showsDiff,
	sortedRules,
	suggestedRulePath,
	validateNewRulePath,
	validateRulePath,
	workspaceOf,
} from "../src/lib/workspaces";

function ws(id: string, kind: Workspace["kind"], root: string, name = id): Workspace {
	return { id, kind, name, root, rules: [], liveSessions: 0 };
}

describe("workspaceOf", () => {
	const list = [
		ws("project:b", "project", "/g/b"),
		ws("project:bc", "project", "/g/bc"),
		ws("project:b-inner", "project", "/g/b/packages/inner"),
		ws("knowledge", "knowledge", "/docs/Job"),
		ws("scratch:1", "scratch", "/tmp/deck-scratch/1"),
	];

	it("matches on a path boundary, so /g/b does not own /g/bcd", () => {
		expect(workspaceOf(list, "/g/b")?.id).toBe("project:b");
		expect(workspaceOf(list, "/g/b/src")?.id).toBe("project:b");
		expect(workspaceOf(list, "/g/bc/src")?.id).toBe("project:bc");
		expect(workspaceOf(list, "/g/bcd")).toBeUndefined();
	});

	it("takes the longest root and ignores trailing slashes", () => {
		expect(workspaceOf(list, "/g/b/packages/inner/x/")?.id).toBe("project:b-inner");
		expect(workspaceOf(list, "/docs/Job/")?.id).toBe("knowledge");
		expect(workspaceOf(list, "/elsewhere")).toBeUndefined();
	});
	it("matches Windows paths across separator styles and without case sensitivity", () => {
		const windows = [ws("project:win", "project", "C:\\Users\\Leo\\repo")];
		expect(workspaceOf(windows, "c:/users/leo/REPO/src")).toBe(windows[0]);
		expect(workspaceOf(windows, "C:\\Users\\Leo\\repository")).toBeUndefined();
	});
});

describe("groupWorkspaces", () => {
	it("orders knowledge, projects by name, scratch and drops empty groups", () => {
		const groups = groupWorkspaces([
			ws("project:z", "project", "/z", "zeta"),
			ws("scratch:1", "scratch", "/s"),
			ws("project:a", "project", "/a", "alpha"),
			ws("knowledge", "knowledge", "/k"),
		]);
		expect(groups.map(g => g.kind)).toEqual(["knowledge", "project", "scratch"]);
		expect(groups[1]!.workspaces.map(w => w.name)).toEqual(["alpha", "zeta"]);
		expect(groupWorkspaces([ws("scratch:1", "scratch", "/s")]).map(g => g.kind)).toEqual(["scratch"]);
	});
});

describe("rules editor logic", () => {
	it("tells how omp treats a rule file: frontmatter decides, a bare .omp/rules file is ignored, AGENTS.md is context", () => {
		expect(ruleActivation(".omp/rules/style.md", "Use tabs.")).toBe("ignored");
		expect(ruleActivation(".omp/rules/style.md", `${RULE_TEMPLATE}Use tabs.`)).toBe("always");
		expect(ruleActivation(".omp/rules/style.md", "---\ndescription: Formatting rules\n---\nUse tabs.")).toBe("on-demand");
		expect(ruleActivation(".omp/rules/style.md", "---\ncondition: console\\.log\n---\nNo logs.")).toBe("conditional");
		expect(ruleActivation(".omp/rules/style.md", "---\nalwaysApply: false\n---\nUse tabs.")).toBe("ignored");
		expect(ruleActivation("AGENTS.md", "Use tabs.")).toBe("context");
		// A new file holding only the template is not saveable yet.
		const draft: RuleDraft = { path: ".omp/rules/style.md", visibility: "private", saved: null, content: RULE_TEMPLATE, isNew: true };
		expect(ruleSaveBlocker(draft)).toBe("Write something first.");
		expect(ruleSaveBlocker({ ...draft, content: `${RULE_TEMPLATE}Use tabs.` })).toBeNull();
	});

	it("rejects paths the daemon would refuse before any request is made", () => {
		for (const bad of ["", "/etc/passwd.md", "../x.md", "a/../b.md", "a//b.md", "./a.md", "a\\b.md", "notes.txt", "C:/x.md"]) {
			expect(validateRulePath(bad).ok).toBe(false);
		}
		expect(validateRulePath(" .omp/rules/testing.md ")).toEqual({ ok: true, path: ".omp/rules/testing.md" });
		expect(validateRulePath("docs/style.mdc").ok).toBe(true);
	});

	it("keeps new private rules under .omp/rules/ and new shared rules at AGENTS.md or docs/", () => {
		expect(validateNewRulePath("private", ".omp/rules/testing.md").ok).toBe(true);
		expect(validateNewRulePath("private", "AGENTS.md").ok).toBe(false);
		expect(validateNewRulePath("private", ".omp/rules/.md").ok).toBe(false);
		expect(validateNewRulePath("shared", "AGENTS.md").ok).toBe(true);
		expect(validateNewRulePath("shared", "docs/style.md").ok).toBe(true);
		expect(validateNewRulePath("shared", ".omp/rules/testing.md").ok).toBe(false);
		expect(validateNewRulePath("shared", "src/notes.md").ok).toBe(false);
	});

	it("suggests a path from a name that always passes its own validation", () => {
		for (const name of ["Testing Rules", "  ", "../../etc", "AGENTS", "ünï"]) {
			for (const visibility of ["private", "shared"] as const) {
				expect(validateNewRulePath(visibility, suggestedRulePath(visibility, name)).ok).toBe(true);
			}
		}
		expect(suggestedRulePath("private", "Testing Rules")).toBe(".omp/rules/testing-rules.md");
	});

	it("saves only real changes, and a new file only with a valid path and content", () => {
		const existing: RuleDraft = { path: "AGENTS.md", visibility: "shared", saved: "a", content: "a", isNew: false };
		expect(ruleDirty(existing)).toBe(false);
		expect(ruleSaveBlocker(existing)).toBe("No changes.");
		expect(ruleSaveBlocker({ ...existing, content: "b" })).toBeNull();
		const fresh: RuleDraft = { path: ".omp/rules/x.md", visibility: "private", saved: null, content: "", isNew: true };
		expect(ruleSaveBlocker(fresh)).toBe("Write something first.");
		expect(ruleSaveBlocker({ ...fresh, content: "rule" })).toBeNull();
		expect(ruleSaveBlocker({ ...fresh, content: "rule", path: "AGENTS.md" })).toContain(".omp/rules/");
	});

	it("lists private rules before shared ones, counts both, and shows a diff only for shared files", () => {
		const rules = [
			{ path: "docs/b.md", visibility: "shared" as const },
			{ path: ".omp/rules/z.md", visibility: "private" as const },
			{ path: "AGENTS.md", visibility: "shared" as const },
			{ path: ".omp/rules/a.md", visibility: "private" as const },
		];
		expect(sortedRules(rules).map(r => r.path)).toEqual([".omp/rules/a.md", ".omp/rules/z.md", "AGENTS.md", "docs/b.md"]);
		expect(ruleCounts(rules)).toEqual({ private: 2, shared: 2 });
		expect(showsDiff("shared", "@@ -1 +1 @@\n-a\n+b")).toBe(true);
		expect(showsDiff("shared", "  \n")).toBe(false);
		expect(showsDiff("private", "@@ -1 +1 @@")).toBe(false);
		expect(showsDiff("shared", undefined)).toBe(false);
	});

	it("classifies unified diff lines", () => {
		const lines = parseDiff("diff --git a/AGENTS.md b/AGENTS.md\n--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n");
		expect(lines.map(l => l.kind)).toEqual(["meta", "meta", "meta", "hunk", "ctx", "del", "add"]);
	});
});
