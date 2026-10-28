/**
 * The deck mark: three stacked cards (a deck) with a terminal prompt on the front one, in the UI's
 * cyan to magenta accent over the near-black UI background. One vector description feeds both the
 * SVG favicon and the PNG rasterizer, so every icon is drawn from the same geometry.
 */

export type Rgb = readonly [number, number, number];

export const BACKGROUND: Rgb = [10, 10, 12];
export const ACCENT_A: Rgb = [90, 216, 230];
export const ACCENT_B: Rgb = [237, 74, 191];

type Point = readonly [number, number];

type Paint =
	| { kind: "solid"; color: Rgb; alpha: number }
	| { kind: "gradient"; from: Rgb; to: Rgb; start: Point; end: Point };

type Shape =
	| { kind: "rrect"; cx: number; cy: number; w: number; h: number; r: number; paint: Paint }
	| { kind: "capsule"; a: Point; b: Point; r: number; paint: Paint };

const MARK_SHIFT_Y = -0.02;

function mixRgb(from: Rgb, to: Rgb, t: number): Rgb {
	return [0, 1, 2].map(i => Math.round(from[i]! + (to[i]! - from[i]!) * t)) as unknown as Rgb;
}

/** Mark geometry in a local frame centred on the origin; the mark spans roughly 0.7 x 0.74. */
const MARK: readonly Shape[] = [
	{
		kind: "rrect",
		cx: 0,
		cy: -0.13 + MARK_SHIFT_Y,
		w: 0.56,
		h: 0.44,
		r: 0.09,
		paint: { kind: "solid", color: ACCENT_A, alpha: 0.32 },
	},
	{
		kind: "rrect",
		cx: 0,
		cy: 0.02 + MARK_SHIFT_Y,
		w: 0.63,
		h: 0.44,
		r: 0.09,
		paint: { kind: "solid", color: mixRgb(ACCENT_A, ACCENT_B, 0.5), alpha: 0.62 },
	},
	{
		kind: "rrect",
		cx: 0,
		cy: 0.17 + MARK_SHIFT_Y,
		w: 0.7,
		h: 0.44,
		r: 0.09,
		paint: { kind: "gradient", from: ACCENT_A, to: ACCENT_B, start: [-0.35, -0.05 + MARK_SHIFT_Y], end: [0.35, 0.39 + MARK_SHIFT_Y] },
	},
	// Prompt: ">" and "_" cut out of the front card in the background colour.
	{
		kind: "capsule",
		a: [-0.2, 0.07 + MARK_SHIFT_Y],
		b: [-0.09, 0.17 + MARK_SHIFT_Y],
		r: 0.026,
		paint: { kind: "solid", color: BACKGROUND, alpha: 1 },
	},
	{
		kind: "capsule",
		a: [-0.09, 0.17 + MARK_SHIFT_Y],
		b: [-0.2, 0.27 + MARK_SHIFT_Y],
		r: 0.026,
		paint: { kind: "solid", color: BACKGROUND, alpha: 1 },
	},
	{
		kind: "capsule",
		a: [-0.02, 0.27 + MARK_SHIFT_Y],
		b: [0.17, 0.27 + MARK_SHIFT_Y],
		r: 0.026,
		paint: { kind: "solid", color: BACKGROUND, alpha: 1 },
	},
];

export interface IconSpec {
	size: number;
	/** Fraction of the canvas the mark's local unit spans; maskable icons use a smaller value to stay in the safe zone. */
	markScale: number;
	/** Background corner radius as a fraction of the canvas; 0 is full-bleed (what iOS and maskable icons want). */
	corner: number;
}

function inside(shape: Shape, x: number, y: number): boolean {
	if (shape.kind === "rrect") {
		const dx = Math.abs(x - shape.cx) - (shape.w / 2 - shape.r);
		const dy = Math.abs(y - shape.cy) - (shape.h / 2 - shape.r);
		const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
		return outside + Math.min(Math.max(dx, dy), 0) <= shape.r;
	}
	const [ax, ay] = shape.a;
	const [bx, by] = shape.b;
	const abx = bx - ax;
	const aby = by - ay;
	const t = Math.max(0, Math.min(1, ((x - ax) * abx + (y - ay) * aby) / (abx * abx + aby * aby)));
	return Math.hypot(x - (ax + abx * t), y - (ay + aby * t)) <= shape.r;
}

function paintAt(paint: Paint, x: number, y: number): { color: Rgb; alpha: number } {
	if (paint.kind === "solid") return { color: paint.color, alpha: paint.alpha };
	const [sx, sy] = paint.start;
	const [ex, ey] = paint.end;
	const dx = ex - sx;
	const dy = ey - sy;
	const t = Math.max(0, Math.min(1, ((x - sx) * dx + (y - sy) * dy) / (dx * dx + dy * dy)));
	return { color: mixRgb(paint.from, paint.to, t), alpha: 1 };
}

const SAMPLES = 6;

/** Rasterizes the icon with SAMPLES x SAMPLES supersampling; returns straight-alpha RGBA8. */
export function renderIcon(spec: IconSpec): Uint8Array {
	const { size, markScale, corner } = spec;
	const out = new Uint8Array(size * size * 4);
	const background: Shape = {
		kind: "rrect",
		cx: 0.5,
		cy: 0.5,
		w: 1,
		h: 1,
		r: corner,
		paint: { kind: "solid", color: BACKGROUND, alpha: 1 },
	};
	const total = SAMPLES * SAMPLES;
	for (let py = 0; py < size; py++) {
		for (let px = 0; px < size; px++) {
			let pr = 0;
			let pg = 0;
			let pb = 0;
			let pa = 0;
			for (let sy = 0; sy < SAMPLES; sy++) {
				for (let sx = 0; sx < SAMPLES; sx++) {
					const u = (px + (sx + 0.5) / SAMPLES) / size;
					const v = (py + (sy + 0.5) / SAMPLES) / size;
					// Source-over compositing, bottom first, into premultiplied accumulators.
					let r = 0;
					let g = 0;
					let b = 0;
					let a = 0;
					const mx = (u - 0.5) / markScale;
					const my = (v - 0.5) / markScale;
					for (let i = -1; i < MARK.length; i++) {
						const shape = i < 0 ? background : MARK[i]!;
						const x = i < 0 ? u : mx;
						const y = i < 0 ? v : my;
						if (!inside(shape, x, y)) continue;
						const src = paintAt(shape.paint, x, y);
						const keep = 1 - src.alpha;
						r = src.color[0] * src.alpha + r * keep;
						g = src.color[1] * src.alpha + g * keep;
						b = src.color[2] * src.alpha + b * keep;
						a = src.alpha + a * keep;
					}
					pr += r;
					pg += g;
					pb += b;
					pa += a;
				}
			}
			const o = (py * size + px) * 4;
			const alpha = pa / total;
			if (alpha > 0) {
				out[o] = Math.round(pr / total / alpha);
				out[o + 1] = Math.round(pg / total / alpha);
				out[o + 2] = Math.round(pb / total / alpha);
			}
			out[o + 3] = Math.round(alpha * 255);
		}
	}
	return out;
}

function css(color: Rgb): string {
	return `rgb(${color[0]},${color[1]},${color[2]})`;
}

/** The same drawing as an SVG (viewBox 0 0 1 1), for the favicon. */
export function renderSvg(spec: Pick<IconSpec, "markScale" | "corner">): string {
	const scale = spec.markScale;
	const num = (n: number) => String(Math.round(n * 10_000) / 10_000);
	const defs: string[] = [];
	const body: string[] = [
		`<rect width="1" height="1" rx="${num(spec.corner)}" fill="${css(BACKGROUND)}"/>`,
		`<g transform="translate(0.5 0.5) scale(${num(scale)})">`,
	];
	MARK.forEach((shape, index) => {
		let fill: string;
		let opacity = "";
		if (shape.paint.kind === "gradient") {
			const id = `g${index}`;
			const [x1, y1] = shape.paint.start;
			const [x2, y2] = shape.paint.end;
			defs.push(
				`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${num(x1)}" y1="${num(y1)}" x2="${num(x2)}" y2="${num(y2)}"><stop offset="0" stop-color="${css(shape.paint.from)}"/><stop offset="1" stop-color="${css(shape.paint.to)}"/></linearGradient>`,
			);
			fill = `url(#${id})`;
		} else {
			fill = css(shape.paint.color);
			if (shape.paint.alpha < 1) opacity = ` fill-opacity="${shape.paint.alpha}"`;
		}
		if (shape.kind === "rrect") {
			body.push(
				`<rect x="${num(shape.cx - shape.w / 2)}" y="${num(shape.cy - shape.h / 2)}" width="${num(shape.w)}" height="${num(shape.h)}" rx="${num(shape.r)}" fill="${fill}"${opacity}/>`,
			);
		} else {
			body.push(
				`<path d="M${num(shape.a[0])} ${num(shape.a[1])}L${num(shape.b[0])} ${num(shape.b[1])}" stroke="${fill}" stroke-width="${num(shape.r * 2)}" stroke-linecap="round" fill="none"${opacity.replace("fill-opacity", "stroke-opacity")}/>`,
			);
		}
	});
	body.push("</g>");
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" width="512" height="512"><defs>${defs.join("")}</defs>${body.join("")}</svg>\n`;
}
