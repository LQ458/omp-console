import { describe, expect, it } from "bun:test";
import type { DeckPanelDescriptor, PluginInfo } from "@omp-console/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { DeckPanel } from "../src/components/plugins/PluginsPanel";
import { groupPlugins, isDeckPanelDescriptor } from "../src/lib/plugins";
import { DeckApi } from "../src/lib/api";

const api = new DeckApi({ fetch: async () => new Response(null, { status: 204 }) });

function markup(descriptor: unknown): string {
	return renderToStaticMarkup(<DeckPanel api={api} sessionId="s" panelKey="fixture" descriptor={descriptor} />);
}

describe("plugin registry grouping", () => {
	it("groups by kind in stable display order and sorts names", () => {
		const plugins: PluginInfo[] = [
			{ id: "z", kind: "tool", name: "Zed", enabled: true },
			{ id: "b", kind: "extension", name: "Beta", enabled: true },
			{ id: "a", kind: "extension", name: "Alpha", enabled: false },
			{ id: "m", kind: "mcp", name: "MCP", enabled: true },
		];
		const groups = groupPlugins(plugins);
		expect(groups.map(group => group.kind)).toEqual(["extension", "mcp", "tool"]);
		expect(groups[0]?.plugins.map(plugin => plugin.name)).toEqual(["Alpha", "Beta"]);
	});
});

describe("extension panel descriptors", () => {
	const descriptors: DeckPanelDescriptor[] = [
		{ kind: "list", title: "List", items: [{ label: "one", detail: "detail" }] },
		{ kind: "kv", title: "KV", rows: [{ key: "mode", value: "fast" }] },
		{ kind: "progress", title: "Progress", value: 2, max: 4, label: "step" },
		{ kind: "markdown", title: "Markdown", text: "**bold**" },
		{ kind: "table", title: "Table", columns: ["A"], rows: [["cell"]] },
		{ kind: "buttons", title: "Buttons", buttons: [{ label: "Run", command: "/run" }] },
	];

	it("accepts and renders every supported kind", () => {
		for (const descriptor of descriptors) {
			expect(isDeckPanelDescriptor(descriptor)).toBe(true);
			const html = markup(descriptor);
			expect(html).toContain(descriptor.title);
		}
		expect(markup(descriptors[0])).toContain("detail");
		expect(markup(descriptors[3])).toContain("<strong>bold</strong>");
		expect(markup(descriptors[4])).toContain("cell");
		expect(markup(descriptors[5])).toContain("Run");
	});

	it("turns an invalid descriptor into a visible error instead of executing it", () => {
		const html = markup({ kind: "script", title: "unsafe", code: "alert(1)" });
		expect(isDeckPanelDescriptor({ kind: "script", title: "unsafe" })).toBe(false);
		expect(html).toContain("invalid omp console panel descriptor");
		expect(html).not.toContain("alert(1)");
	});
});
