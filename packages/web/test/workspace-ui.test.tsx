import { describe, expect, it } from "bun:test";
import type { MovePreview, SessionSummary, Workspace } from "@omp-console/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { MovePanel } from "../src/components/safety/MovePanel";
import { SessionSidebar } from "../src/components/switcher/SessionSidebar";
import { ModeBadges, WorkspaceChip } from "../src/components/workspaces/WorkspaceChip";
import { buildWorkspaceContext, WorkspaceContext } from "../src/components/workspaces/WorkspaceProvider";
import { RulesEditor } from "../src/components/workspaces/RulesEditor";
import { modeBadges } from "../src/lib/mode-badges";
import { MoveFlow, type NativeInvoke } from "../src/lib/move";
import { workspaceColor } from "../src/lib/workspace-color";

function workspace(id: string, kind: Workspace["kind"], root: string, extra: Partial<Workspace> = {}): Workspace {
	return { id, kind, name: id.split(":").pop()!, root, rules: [], liveSessions: 0, ...extra };
}

function session(id: string, cwd: string): SessionSummary {
	return {
		id,
		title: `title-${id}`,
		cwd,
		sessionFile: `${cwd}/${id}.jsonl`,
		state: "idle",
		createdAt: 1,
		lastActivityAt: Date.now(),
		agentCount: 0,
		goalActive: false,
		awaitingAnswer: false,
	};
}

const noop = (): void => {};

describe("session rows", () => {
	it("keeps one session state dot instead of adding a workspace dot inside each row", () => {
		const context = buildWorkspaceContext(
			[workspace("project:relay", "project", "/g/relay"), workspace("project:rel", "project", "/g/rel")],
			"dark",
			{ loaded: true, error: null, refresh: async () => {} },
		);
		const html = renderToStaticMarkup(
			<WorkspaceContext.Provider value={context}>
				<SessionSidebar
					sessions={{ live: [session("a", "/g/relay/src"), session("b", "/elsewhere")], recent: [session("c", "/g/rel")] }}
					health={null}
					listError={null}
					authFailed={false}
					selectedId={null}
					busy={false}
					actionError={null}
					onSelect={noop}
					onResume={noop}
					onFork={noop}
					onStop={noop}
					onCreate={noop}
				/>
			</WorkspaceContext.Provider>,
		);
		expect(html.match(/aria-label="live,/g)).toHaveLength(2);
		expect(html).not.toContain('aria-label="workspace relay"');
		expect(html).not.toContain('aria-label="workspace rel"');
		expect(html).toContain("title-b");
	});
});

describe("chip and badges", () => {
	it("render the workspace name on its own colours, ringed while a goal runs, with stacked badges", () => {
		const relay = workspace("project:relay", "project", "/g/relay");
		const color = workspaceColor(relay, "light", []);
		const chip = renderToStaticMarkup(<WorkspaceChip workspace={relay} color={color} goalRing />);
		expect(chip).toContain('data-ring="goal"');
		expect(chip).toContain(`--ws-accent:${color.accent}`);
		const badges = renderToStaticMarkup(
			<ModeBadges badges={modeBadges({ goal: { active: true, progress: 0.5 }, plan: true, phone: true })} />,
		);
		expect([...badges.matchAll(/data-badge="(\w+)"/g)].map(m => m[1])).toEqual(["goal", "plan", "phone"]);
		expect(badges).toContain("width:50%");
		expect(renderToStaticMarkup(<ModeBadges badges={[]} />)).toBe("");
	});
});

const PREVIEW: MovePreview = {
	id: "mv1",
	destination: "/Users/dev/Documents/GitHub/new-tool",
	files: 12,
	bytes: 2_048,
	excluded: [
		{ path: ".env", reason: "secret" },
		{ path: "node_modules", reason: "dependency-dir" },
	],
	nonce: "n",
	expiresAt: Date.now() + 60_000,
};

async function preparedFlow(invoke: NativeInvoke | null): Promise<MoveFlow> {
	const flow = new MoveFlow({
		api: { prepareMove: async () => PREVIEW, confirmMove: () => Promise.reject(new Error("must not be called")) },
		invoke: () => invoke,
	});
	await flow.prepare({ id: "sg" }, "new-tool");
	return flow;
}

describe("MovePanel", () => {
	it("shows only daemon facts and what is left out, and offers no enabled confirm outside the Mac app", async () => {
		const html = renderToStaticMarkup(
			<MovePanel flow={await preparedFlow(null)} onPrepareAgain={noop} onOpenSession={noop} onUndo={noop} />,
		);
		expect(html).toContain("/Users/dev/Documents/GitHub/new-tool");
		expect(html).toContain(".env");
		expect(html).toContain("looks like a secret");
		expect(html).toContain("Confirm on the Mac app");
		expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Confirm on the Mac app/s);
	});

	it("offers the native confirmation when the Mac bridge exists", async () => {
		const html = renderToStaticMarkup(
			<MovePanel flow={await preparedFlow(async () => "token")} onPrepareAgain={noop} onOpenSession={noop} onUndo={noop} />,
		);
		expect(html).toContain("Confirm in the Mac app…");
		expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Confirm in the Mac app/s);
	});
});

describe("RulesEditor", () => {
	it("explains who sees what and lists private rules before shared ones with their visibility", () => {
		const html = renderToStaticMarkup(
			<RulesEditor
				api={{ readRuleFile: () => Promise.reject(new Error("unused")), writeRuleFile: async () => {} }}
				workspace={workspace("project:relay", "project", "/g/relay", {
					rules: [
						{ path: "AGENTS.md", visibility: "shared" },
						{ path: ".omp/rules/testing.md", visibility: "private" },
					],
				})}
				onBack={noop}
				onSaved={noop}
			/>,
		);
		expect(html).toContain("Coworkers never see it");
		expect(html).toContain("omp console shows the git diff and never commits");
		expect(html.indexOf(".omp/rules/testing.md")).toBeLessThan(html.indexOf("AGENTS.md</code>"));
		expect(html).toContain("1 private · 1 shared");
	});
});
