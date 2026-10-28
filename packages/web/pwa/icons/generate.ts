/**
 * Regenerates every icon under `public/` from the vector design in `design.ts`.
 *
 *   bun pwa/icons/generate.ts
 *
 * Output is deterministic; the PNGs are committed.
 */
import * as path from "node:path";
import { type IconSpec, renderIcon, renderSvg } from "./design";
import { encodeIco, encodePng } from "./png";

/** Icons the manifest and `index.html` reference, with how each is drawn. */
export const ICONS: Record<string, IconSpec> = {
	"icon-192.png": { size: 192, markScale: 0.7, corner: 0 },
	"icon-512.png": { size: 512, markScale: 0.7, corner: 0 },
	// Maskable: full-bleed, mark inside the central 80% safe-zone circle (half diagonal 0.37 * 0.74 < 0.4).
	"icon-maskable-512.png": { size: 512, markScale: 0.58, corner: 0 },
	// iOS fills transparency with black and applies its own corner mask, so this one is full-bleed too.
	"apple-touch-icon.png": { size: 180, markScale: 0.7, corner: 0 },
	"favicon.png": { size: 256, markScale: 0.78, corner: 0.2 },
	"favicon-32x32.png": { size: 32, markScale: 0.82, corner: 0.2 },
	"favicon-16x16.png": { size: 16, markScale: 0.86, corner: 0.2 },
};

export function renderAll(): Map<string, Uint8Array | string> {
	const out = new Map<string, Uint8Array | string>();
	const pngs = new Map<string, Uint8Array>();
	for (const [name, spec] of Object.entries(ICONS)) {
		const png = encodePng(spec.size, spec.size, renderIcon(spec));
		pngs.set(name, png);
		out.set(name, png);
	}
	out.set(
		"favicon.ico",
		encodeIco([
			{ size: 16, png: pngs.get("favicon-16x16.png")! },
			{ size: 32, png: pngs.get("favicon-32x32.png")! },
		]),
	);
	out.set("favicon.svg", renderSvg({ markScale: 0.78, corner: 0.2 }));
	return out;
}

if (import.meta.main) {
	const publicDir = path.resolve(import.meta.dir, "../../public");
	for (const [name, data] of renderAll()) {
		await Bun.write(path.join(publicDir, name), data);
		console.log(`wrote public/${name}`);
	}
}
