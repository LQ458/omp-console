import type { GitDiffViewProps } from "../src/components/git/GitPanel";
import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GitDiffView } from "../src/components/git/GitPanel";

const diff: GitDiffViewProps["diff"] = {
	kind: "text",
	canPatch: true,
	hunks: [{
		header: "@@ -4,3 +4,3 @@",
		patchHash: "a".repeat(64),
		lines: [
			{ kind: "context", text: "before" },
			{ kind: "del", text: "old value" },
			{ kind: "add", text: "new value" },
		],
	}],
};

function render(overrides: Partial<GitDiffViewProps> = {}): string {
	return renderToStaticMarkup(createElement(GitDiffView, {
		diff,
		selectedArea: "unstaged",
		readOnly: false,
		revisionMode: false,
		busy: false,
		onApplyHunk: () => {},
		...overrides,
	}));
}

describe("Git unified diff view", () => {
	it("renders changed lines with their semantic kinds and puts hunk staging beside the header", () => {
		const html = render();
		expect(html).toContain("@@ -4,3 +4,3 @@");
		expect(html).toContain('data-kind="context"');
		expect(html).toContain('data-kind="del"');
		expect(html).toContain("old value");
		expect(html).toContain('data-kind="add"');
		expect(html).toContain("new value");
		expect(html).toContain("Stage hunk 1");
		let stagingButtonsInHeader = 0;
		new HTMLRewriter().on(".git-diff-hunk-head button", { element: () => { stagingButtonsInHeader++; } }).transform(html);
		expect(stagingButtonsInHeader).toBe(1);
	});

	it("keeps the diff visible without exposing hunk mutation in read-only sessions", () => {
		const html = render({ readOnly: true });
		expect(html).toContain("new value");
		expect(html).not.toContain("Stage hunk 1");
	});
});
