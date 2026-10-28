import { describe, expect, it } from "bun:test";
import type { WorkspaceKind } from "@omp-console/protocol";
import {
	assignWorkspaceColors,
	blend,
	type ColorSubject,
	contrastRatio,
	hashName,
	hueDistance,
	KNOWLEDGE_HUE,
	MIN_HUE_GAP,
	PALETTE_HUES,
	PROJECT_HUES,
	type Rgb,
	THEME_SURFACES,
	type WorkspaceColor,
	type WorkspaceTheme,
	workspaceColor,
	workspaceVars,
} from "../src/lib/workspace-color";

const THEMES: readonly WorkspaceTheme[] = ["light", "dark"];

function hex(value: string): Rgb {
	const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(value);
	if (!m) throw new Error(`not a hex colour: ${value}`);
	return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
}

function rgbaParts(value: string): { rgb: Rgb; alpha: number } {
	const m = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(value);
	if (!m) throw new Error(`not an rgba colour: ${value}`);
	return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], alpha: Number(m[4]) };
}

function subject(name: string, kind: WorkspaceKind = "project", extra: Partial<ColorSubject> = {}): ColorSubject {
	return { id: `${kind}:${name}`, kind, name, root: `/Users/dev/GitHub/${name}`, ...extra };
}

function hueOf(color: WorkspaceColor): number {
	if (color.hue === null) throw new Error("neutral colour has no hue");
	return color.hue;
}

describe("workspaceColor", () => {
	it("gives the same hue for the same repo name on every run, whatever order the list arrives in", () => {
		const names = ["relay", "docs", "site", "api", "deck", "mobile"];
		const forward = assignWorkspaceColors(names.map(n => subject(n)), "dark");
		const reversed = assignWorkspaceColors([...names].reverse().map(n => subject(n)), "dark");
		for (const n of names) expect(reversed.get(`project:${n}`)).toEqual(forward.get(`project:${n}`));
		expect(hashName("relay")).toBe(hashName("relay"));
		// The hue follows the repo directory, not the display name.
		const renamed = workspaceColor(subject("relay", "project", { name: "Relay (renamed)" }), "dark", []);
		expect(renamed).toEqual(workspaceColor(subject("relay"), "dark", []));
	});

	it("keeps chip text >= 4.5:1 and accents >= 3:1 on every surface, for every palette hue, in both themes", () => {
		const all: ColorSubject[] = [
			...PALETTE_HUES.map(hue => subject(`h${hue}`, "project", { hueOverride: hue })),
			subject("knowledge", "knowledge"),
			subject("scratch", "scratch"),
		];
		for (const theme of THEMES) {
			for (const w of all) {
				const color = workspaceColor(w, theme, []);
				const { rgb: chip, alpha } = rgbaParts(color.chipBg);
				for (const surface of THEME_SURFACES[theme]) {
					const chipOnSurface = blend(chip, alpha, surface);
					expect(contrastRatio(hex(color.accentText), chipOnSurface)).toBeGreaterThanOrEqual(4.5);
					expect(contrastRatio(hex(color.accent), surface)).toBeGreaterThanOrEqual(3);
				}
			}
		}
	});

	it("tells knowledge (teal), scratch (grey) and projects apart", () => {
		const knowledge = workspaceColor(subject("job", "knowledge"), "light", []);
		const scratch = workspaceColor(subject("tmp", "scratch"), "light", []);
		expect(knowledge.hue).toBe(KNOWLEDGE_HUE);
		expect(scratch.hue).toBeNull();
		const [r, g, b] = hex(scratch.accent);
		expect(r === g && g === b).toBe(true);
		const project = workspaceColor(subject("relay"), "light", [KNOWLEDGE_HUE]);
		expect(hueDistance(hueOf(project), KNOWLEDGE_HUE)).toBeGreaterThanOrEqual(MIN_HUE_GAP);
	});

	it("moves the later of two repos that hash to one hue at least 30 degrees away", () => {
		const slots = new Map<number, string>();
		let pair: [string, string] | null = null;
		for (let i = 0; pair === null && i < 500; i++) {
			const name = `repo-${i}`;
			const slot = hashName(name) % PALETTE_HUES.length;
			const earlier = slots.get(slot);
			if (earlier !== undefined) pair = [earlier, name];
			else slots.set(slot, name);
		}
		expect(pair).not.toBeNull();
		const [first, second] = pair!;
		const colors = assignWorkspaceColors([subject(second), subject(first)], "dark");
		const a = hueOf(colors.get(`project:${first}`)!);
		const b = hueOf(colors.get(`project:${second}`)!);
		expect(hueDistance(a, b)).toBeGreaterThanOrEqual(MIN_HUE_GAP);
	});

	it("with 13 workspaces: knowledge plus the first 9 projects are pairwise >= 30 degrees apart, no project is near the knowledge teal, later ones reuse stably", () => {
		const projects = Array.from({ length: 12 }, (_, i) => subject(`proj-${String(i).padStart(2, "0")}`));
		const list: ColorSubject[] = [subject("job", "knowledge"), ...projects];
		const colors = assignWorkspaceColors(list, "dark");
		expect(colors.size).toBe(13);
		const ordered = [colors.get("knowledge:job")!, ...projects.map(p => colors.get(p.id)!)];
		const hues = ordered.map(hueOf);
		const distinct = 1 + PROJECT_HUES.length;
		for (let i = 0; i < distinct; i++) {
			for (let j = i + 1; j < distinct; j++) expect(hueDistance(hues[i]!, hues[j]!)).toBeGreaterThanOrEqual(MIN_HUE_GAP);
		}
		for (const hue of hues.slice(1)) expect(hueDistance(hue, KNOWLEDGE_HUE)).toBeGreaterThan(MIN_HUE_GAP);
		// Projects past the palette reuse a project hue deterministically, whatever the list order.
		expect(PROJECT_HUES).toContain(hues[12]!);
		expect(assignWorkspaceColors([...list].reverse(), "dark").get(projects[11]!.id)).toEqual(colors.get(projects[11]!.id));
	});

	it("honours an override and keeps other projects away from it", () => {
		const colors = assignWorkspaceColors(
			[subject("relay", "project", { hueOverride: 200 }), subject("docs"), subject("site")],
			"light",
		);
		expect(colors.get("project:relay")!.hue).toBe(200);
		for (const id of ["project:docs", "project:site"]) {
			expect(hueDistance(hueOf(colors.get(id)!), 200)).toBeGreaterThanOrEqual(MIN_HUE_GAP);
		}
		expect(workspaceColor(subject("relay", "project", { hueOverride: -160 }), "light", []).hue).toBe(200);
	});

	it("exports the CSS variables the views apply", () => {
		const color = workspaceColor(subject("relay"), "dark", []);
		expect(workspaceVars(color)).toEqual({
			"--ws-accent": color.accent,
			"--ws-accent-text": color.accentText,
			"--ws-tint": color.tint,
			"--ws-chip-bg": color.chipBg,
		});
	});
});
