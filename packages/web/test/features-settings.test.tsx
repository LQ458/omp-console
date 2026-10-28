import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DaemonConfigFeatureStatus } from "@omp-console/protocol";
import { buildFeatureConfig, FeatureStatusLabel, type FeatureConfigDraft } from "../src/components/shell/FeaturesSettings";

const status = (value: Partial<DaemonConfigFeatureStatus>): DaemonConfigFeatureStatus => ({
	configured: false,
	effective: false,
	missing: [],
	overriddenByFlag: false,
	...value,
});

describe("optional feature settings", () => {
	it("renders every daemon status distinctly", () => {
		const html = renderToStaticMarkup(
			<>
				<FeatureStatusLabel status={status({ configured: true, effective: true })} />
				<FeatureStatusLabel status={status({})} />
				<FeatureStatusLabel status={status({ configured: true, missing: ["Notes folder", "at least one Project folder"] })} />
				<FeatureStatusLabel status={status({ overriddenByFlag: true })} />
			</>,
		);
		expect(html.match(/role="status"/g)).toHaveLength(4);
		expect(html).toContain(">On</p>");
		expect(html).toContain(">Off</p>");
		expect(html).toContain(">Enabled but missing: Notes folder, at least one Project folder</p>");
		expect(html).toContain(">Set by a startup flag</p>");
	});

	it("builds the complete replacement config while preserving unrelated daemon settings", () => {
		const draft: FeatureConfigDraft = {
			features: {
				librarian: true,
				agenda: false,
				quickAsk: true,
				peers: true,
				openrouterDecisions: true,
				computerUse: false,
				overnight: false,
			},
			quickAsk: { sources: ["repo", "history"] },
			knowledgeRoot: "/data/knowledge",
			projectRoots: ["/work/repo", "  "],
			scheduleFile: "/state/schedules.json",
			agendaHub: "/work/tasks-hub",
			peers: [{ id: "studio", name: "Studio", url: "https://studio.example", tokenFile: "/state/peer-token" }],
		};
		const config = buildFeatureConfig(draft);
		expect(config).toEqual({
			features: draft.features,
			quickAsk: { sources: ["repo", "history"] },
			knowledgeRoot: "/data/knowledge",
			projectRoots: ["/work/repo"],
			scheduleFile: "/state/schedules.json",
			agendaHub: "/work/tasks-hub",
			peers: [{ id: "studio", name: "Studio", url: "https://studio.example", tokenFile: "/state/peer-token" }],
		});
	});
});
