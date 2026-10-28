import { describe, expect, it } from "bun:test";
import type { ListModelsResponse } from "@omp-console/protocol";
import { buildModelGroups, labelForSelector, ROLE_GROUP_ID } from "../src/lib/agent-models";
import { clampZoom, fitTransform, MAX_ZOOM, MIN_ZOOM, panBy, zoomAt } from "../src/lib/agent-viewport";

const LIST: ListModelsResponse = {
	models: [
		{ selector: "openai-codex/gpt-6-luna", provider: "openai-codex", label: "GPT-6 Luna", available: true },
		{ selector: "anthropic/claude-sonnet-5-5", provider: "anthropic", label: "Claude Sonnet 5.5", available: true },
		{ selector: "anthropic/claude-opus-5-5", provider: "anthropic", label: "Claude Opus 5.5", available: false },
		{ selector: "anthropic/claude-haiku-5-5", provider: "anthropic", label: "Claude Haiku 5.5", available: true },
	],
	roles: { smol: "openai-codex/gpt-6-luna", plan: "anthropic/claude-opus-5-5", odd: "mystery/model" },
};

describe("buildModelGroups", () => {
	it("lists role aliases first, then providers alphabetically, available models before unavailable ones", () => {
		const groups = buildModelGroups(LIST, "");
		expect(groups.map(group => group.id)).toEqual([ROLE_GROUP_ID, "anthropic", "openai-codex"]);
		expect(groups[0]!.items.map(item => item.selector)).toEqual(["odd", "plan", "smol"]);
		expect(groups[1]!.items.map(item => item.selector)).toEqual([
			"anthropic/claude-haiku-5-5",
			"anthropic/claude-sonnet-5-5",
			"anthropic/claude-opus-5-5",
		]);
	});

	it("keeps unavailable models visible but marked, and a role inherits its target's availability", () => {
		const items = buildModelGroups(LIST, "").flatMap(group => group.items);
		expect(items.find(item => item.selector === "anthropic/claude-opus-5-5")?.available).toBe(false);
		expect(items.find(item => item.selector === "plan")?.available).toBe(false);
		expect(items.find(item => item.selector === "smol")?.available).toBe(true);
		// A role whose target the list does not know is not proven unusable.
		expect(items.find(item => item.selector === "odd")?.available).toBe(true);
	});

	it("needs every word of the query, matching selector, label, provider and role target", () => {
		const ids = (query: string): string[] =>
			buildModelGroups(LIST, query).flatMap(group => group.items.map(item => item.selector));
		expect(ids("sonnet")).toEqual(["anthropic/claude-sonnet-5-5"]);
		expect(ids("CLAUDE 5.5 haiku")).toEqual(["anthropic/claude-haiku-5-5"]);
		expect(ids("codex")).toEqual(["smol", "openai-codex/gpt-6-luna"]); // the role matches through its target
		expect(ids("luna sonnet")).toEqual([]);
		expect(buildModelGroups(LIST, "no-such-thing")).toEqual([]);
		expect(ids("  ")).toHaveLength(7);
	});

	it("names a selector by its label when the list knows it", () => {
		expect(labelForSelector(LIST, "anthropic/claude-haiku-5-5")).toBe("Claude Haiku 5.5");
		expect(labelForSelector(LIST, "x/y")).toBe("x/y");
		expect(labelForSelector(null, "x/y")).toBe("x/y");
	});
});

describe("graph viewport maths", () => {
	it("zooming keeps the content point under the cursor fixed and stays within limits", () => {
		const t = { x: 40, y: -10, k: 1 };
		const px = 300;
		const py = 120;
		const contentX = (px - t.x) / t.k;
		const contentY = (py - t.y) / t.k;
		const zoomed = zoomAt(t, px, py, 1.6);
		expect(zoomed.k).toBeCloseTo(1.6, 10);
		expect(contentX * zoomed.k + zoomed.x).toBeCloseTo(px, 8);
		expect(contentY * zoomed.k + zoomed.y).toBeCloseTo(py, 8);
		expect(zoomAt(t, px, py, 1000).k).toBe(MAX_ZOOM);
		expect(zoomAt(t, px, py, 0.0001).k).toBe(MIN_ZOOM);
		expect(clampZoom(1)).toBe(1);
	});

	it("fits wide content into a narrow viewport without ever enlarging past 1:1, centred", () => {
		const fitted = fitTransform({ width: 800, height: 300 }, { width: 400, height: 600 }, 0);
		expect(fitted.k).toBe(0.5);
		expect(fitted.x).toBe(0);
		expect(fitted.y).toBe((600 - 150) / 2);
		const small = fitTransform({ width: 100, height: 100 }, { width: 400, height: 600 }, 0);
		expect(small.k).toBe(1);
		expect(small.x).toBe(150);
		expect(fitTransform({ width: 100, height: 100 }, { width: 0, height: 0 })).toEqual({ x: 0, y: 0, k: 1 });
		expect(panBy({ x: 1, y: 2, k: 3 }, 10, -5)).toEqual({ x: 11, y: -3, k: 3 });
	});
});
