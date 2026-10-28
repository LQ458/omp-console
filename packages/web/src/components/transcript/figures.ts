import { buildChart, planChart, worthCharting } from "@oh-my-pi/pi-tui/charts/chart-plan";
import { renderChartSvg } from "@oh-my-pi/pi-tui/charts/chart-svg";
import { analyzeTable } from "@oh-my-pi/pi-tui/charts/table-data";
import { closePartialSvg, prepareSvg } from "@oh-my-pi/pi-tui/chat/svg-source";
import { WIDGET_KIT_CSS, WIDGET_THEME_BRIDGE } from "./widget-kit";
import type { FigureKind } from "./figure-extension";

const MERMAID_MODULE = "/vendor/mermaid-12.2.0/mermaid.esm.min.mjs";
export const WIDGET_FRAME_URL = "/widget-frame.html";
const WIDGET_MIN_HEIGHT = 48;
const WIDGET_MAX_HEIGHT = 900;
const CHART_CACHE_LIMIT = 256;

interface ChartTable {
	header: string[];
	rows: string[][];
}

const charts = new Map<string, string | null>();

export function tableChartSvg(source: string): string | null {
	const cached = charts.get(source);
	if (cached !== undefined) return cached;
	let svg: string | null = null;
	try {
		const table = JSON.parse(source) as ChartTable;
		const analysis = analyzeTable(table.header, table.rows);
		const plan = planChart(analysis);
		const spec = plan ? buildChart(analysis, plan) : undefined;
		svg = spec && worthCharting(spec) ? renderChartSvg(spec) : null;
	} catch {
		svg = null;
	}
	if (charts.size >= CHART_CACHE_LIMIT) charts.delete(charts.keys().next().value!);
	charts.set(source, svg);
	return svg;
}

// ---- DOM side ------------------------------------------------------------------------------------------------------

/** Figure tokens (omp's SVG contract) → deck theme variables. */
const TOKEN_VARS: Readonly<Record<string, string>> = {
	fg: "--fg",
	muted: "--fg-muted",
	border: "--border-strong",
	surface: "--bg-raised",
	accent: "--accent",
	success: "--ok",
	warning: "--warn",
	error: "--err",
	c1: "--fig-c1",
	c2: "--fig-c2",
	c3: "--fig-c3",
	c4: "--fig-c4",
	c5: "--fig-c5",
	c6: "--fig-c6",
};
const MOTION_VARS = ["dur-fast", "dur-base", "dur-slow", "ease-out", "ease-in-out", "ease-spring"] as const;
type WidgetMotion = Record<(typeof MOTION_VARS)[number], string>;
const MOTION_FALLBACKS: WidgetMotion = {
	"dur-fast": "120ms",
	"dur-base": "200ms",
	"dur-slow": "320ms",
	"ease-out": "ease-out",
	"ease-in-out": "ease-in-out",
	"ease-spring": "ease-out",
};

function widgetMotion(): WidgetMotion {
	const style = getComputedStyle(document.documentElement);
	const motion = { ...MOTION_FALLBACKS };
	for (const token of MOTION_VARS) {
		const value = style.getPropertyValue(`--${token}`).trim();
		if (value) motion[token] = value;
	}
	return motion;
}

function motionCssVariables(motion: WidgetMotion): string {
	return MOTION_VARS.map(token => `--${token}:${motion[token]};`).join("");
}

export function figurePalette(element: Element): Record<string, string> {
	const style = getComputedStyle(element);
	const palette: Record<string, string> = {};
	for (const [token, cssVar] of Object.entries(TOKEN_VARS)) {
		const value = style.getPropertyValue(cssVar).trim();
		if (value) palette[token] = value;
	}
	return palette;
}

function isDarkTheme(): boolean {
	const explicit = document.documentElement.dataset.theme;
	if (explicit === "light") return false;
	if (explicit === "dark") return true;
	return !window.matchMedia("(prefers-color-scheme: light)").matches;
}

function svgDataUrl(svg: string): string {
	return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Width the figure asks for (its `width`, else its viewBox width), so a small figure is not blown up to the column. */
function intrinsicWidth(svg: string): number | undefined {
	const root = /<(?:[\w.-]+:)?svg(?=[\s/>])[^>]*>/.exec(svg)?.[0];
	if (!root) return undefined;
	const width = /\swidth\s*=\s*["']\s*([\d.]+)(?:px)?\s*["']/.exec(root)?.[1];
	if (width) return Number(width);
	const viewBox = /\sviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)/.exec(root)?.[1];
	return viewBox ? Number(viewBox) : undefined;
}

/** Put `svg` in the figure as an image; a source the browser cannot draw shows the code instead. */
function showImage(figure: HTMLElement, svg: string, label: string): void {
	let img = figure.querySelector<HTMLImageElement>(":scope > img.tr-fig-img");
	if (!img) {
		img = document.createElement("img");
		img.className = "tr-fig-img";
		img.decoding = "async";
		img.addEventListener("error", () => failed(figure));
		img.addEventListener("load", () => figure.classList.remove("tr-fig--failed"));
		figure.prepend(img);
	}
	img.alt = label;
	const width = intrinsicWidth(svg);
	if (width !== undefined && Number.isFinite(width) && width > 0) img.style.width = `${width}px`;
	img.src = svgDataUrl(svg);
	figure.classList.add("tr-fig--drawn");
}

/** A figure the browser could not draw (malformed SVG, Mermaid syntax error): show its source instead. */
function failed(figure: HTMLElement): void {
	figure.classList.add("tr-fig--failed");
	figure.querySelector("details.tr-fig-source")?.setAttribute("open", "");
}

/** The fence's code block moves into a collapsed "Source" disclosure once the figure is drawn. */
function tuckSource(figure: HTMLElement): void {
	const pre = figure.querySelector<HTMLElement>(":scope > pre");
	if (!pre) return;
	const details = document.createElement("details");
	details.className = "tr-fig-source";
	const summary = document.createElement("summary");
	summary.textContent = "Source";
	details.append(summary, pre);
	// The caption reads as part of the figure; the source is the last, quiet line.
	figure.append(details);
}

interface MermaidApi {
	initialize(config: Record<string, unknown>): void;
	render(id: string, text: string): Promise<{ svg: string }>;
}

let mermaidModule: Promise<MermaidApi> | undefined;
let mermaidSequence = 0;
/** Rendered diagrams per theme + source; rendering one costs tens of milliseconds and re-renders are frequent. */
const diagrams = new Map<string, Promise<string>>();

function loadMermaid(): Promise<MermaidApi> {
	// A runtime URL, not a bundled import: the 5 MB library loads only when a diagram is on screen.
	const url: string = MERMAID_MODULE;
	mermaidModule ??= (import(url) as Promise<{ default: MermaidApi }>).then(module => module.default);
	return mermaidModule;
}

function renderDiagram(source: string, palette: Record<string, string>, dark: boolean): Promise<string> {
	const key = `${dark ? "d" : "l"}\u0000${JSON.stringify(palette)}\u0000${source}`;
	let pending = diagrams.get(key);
	if (!pending) {
		pending = loadMermaid().then(async mermaid => {
			mermaid.initialize({
				startOnLoad: false,
				securityLevel: "strict",
				theme: "base",
				darkMode: dark,
				htmlLabels: false,
				flowchart: { htmlLabels: false },
				fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
				themeVariables: {
					darkMode: dark,
					background: "transparent",
					primaryColor: palette.surface,
					primaryTextColor: palette.fg,
					primaryBorderColor: palette.border,
					secondaryColor: palette.surface,
					tertiaryColor: palette.surface,
					lineColor: palette.muted,
					textColor: palette.fg,
					mainBkg: palette.surface,
					nodeBorder: palette.border,
					clusterBkg: "transparent",
					titleColor: palette.fg,
					edgeLabelBackground: palette.surface,
					noteBkgColor: palette.surface,
					noteTextColor: palette.fg,
					actorBkg: palette.surface,
					actorBorder: palette.border,
					actorTextColor: palette.fg,
					signalColor: palette.fg,
					signalTextColor: palette.fg,
				},
			});
			const { svg } = await mermaid.render(`deck-mermaid-${++mermaidSequence}`, source);
			return fixedSizeDiagram(svg);
		});
		pending.catch(() => diagrams.delete(key));
		if (diagrams.size >= CHART_CACHE_LIMIT) diagrams.delete(diagrams.keys().next().value!);
		diagrams.set(key, pending);
	}
	return pending;
}

/**
 * Mermaid sizes its root `width="100%"` with an inline `max-width`; inside an `<img>` that draws the diagram at its
 * max-width in the corner of an image sized from the viewBox. The root gets the viewBox size as its own.
 */
function fixedSizeDiagram(svg: string): string {
	return svg.replace(/<svg\b[^>]*>/, tag => {
		const box = /\sviewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/.exec(tag);
		if (!box) return tag;
		const cleaned = tag.replace(/\s(?:width|height)="[^"]*"/g, "").replace(/\sstyle="[^"]*"/, "");
		return cleaned.replace(/^<svg/, `<svg width="${box[1]}" height="${box[2]}"`);
	});
}

interface WidgetFrameEntry {
	frame: HTMLIFrameElement;
	source: string;
	documentText: string;
}

/** Live widget frames → their figure, for height and theme messages; a removed frame's window drops out by itself. */
const widgetFrames = new WeakMap<Window, WidgetFrameEntry>();
let widgetListener = false;

function listenToWidgets(): void {
	if (widgetListener) return;
	widgetListener = true;
	window.addEventListener("message", event => {
		const source = event.source as Window | null;
		if (!source) return;
		const entry = widgetFrames.get(source);
		if (!entry) return;
		if (!entry.frame.isConnected) {
			widgetFrames.delete(source);
			return;
		}
		const data = event.data as { deckWidgetFrame?: unknown; deckWidgetHeight?: unknown } | null;
		if (data?.deckWidgetFrame === "ready") {
			source.postMessage({ deckWidgetDocument: entry.documentText }, "*");
		} else if (typeof data?.deckWidgetHeight === "number" && Number.isFinite(data.deckWidgetHeight)) {
			const height = Math.min(WIDGET_MAX_HEIGHT, Math.max(WIDGET_MIN_HEIGHT, Math.ceil(data.deckWidgetHeight)));
			entry.frame.style.height = `${height}px`;
		}
	});
}

/**
 * The document a widget runs as: deck's theme as CSS variables, a transparent page in the reader's color scheme,
 * the widget design kit, the agent's HTML, and a reporter that keeps the frame as tall as its content.
 */
export function widgetDocument(source: string, palette: Record<string, string>, dark: boolean, motion = widgetMotion()): string {
	const vars = Object.entries(palette)
		.map(([token, value]) => `--${token}:${value};`)
		.join("");
	const motionVars = motionCssVariables(motion);
	return [
		"<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
		`<style>:root{color-scheme:${dark ? "dark" : "light"};${vars}${motionVars}}html,body{margin:0;padding:0;background:transparent;color:var(--fg);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,sans-serif}body{display:flow-root;padding:0}</style>`,
		`<style>${WIDGET_KIT_CSS}</style>`,
		`<script>${WIDGET_THEME_BRIDGE}</script>`,
		"</head><body>",
		source,
		// The body's height, not the document's: a document is never shorter than its frame, so the frame could grow
		// but never shrink to a small widget.
		"<script>(()=>{const post=()=>{const r=document.body.getBoundingClientRect();const s=getComputedStyle(document.body);parent.postMessage({deckWidgetHeight:Math.ceil(r.height+parseFloat(s.marginTop)+parseFloat(s.marginBottom))},\"*\")};new ResizeObserver(post).observe(document.body);addEventListener(\"load\",post);post();})();</script>",
		"</body></html>",
	].join("");
}

function updateWidgetTheme(entry: WidgetFrameEntry, palette: Record<string, string>, dark: boolean, motion: WidgetMotion): void {
	entry.documentText = widgetDocument(entry.source, palette, dark, motion);
	entry.frame.style.colorScheme = dark ? "dark" : "light";
	entry.frame.contentWindow?.postMessage({ deckWidgetTheme: { palette, dark, motion } }, "*");
}

function showWidget(
	figure: HTMLElement,
	source: string,
	palette: Record<string, string>,
	dark: boolean,
	motion: WidgetMotion,
	title?: string,
): void {
	listenToWidgets();
	const frame = document.createElement("iframe");
	frame.className = "tr-fig-frame";
	frame.title = title ? `${title} interactive widget` : "Interactive widget";
	// Scripts only: no same-origin (so no deck cookies, storage or API), no forms, popups or top navigation.
	frame.setAttribute("sandbox", "allow-scripts");
	frame.setAttribute("referrerpolicy", "no-referrer");
	frame.style.height = "160px";
	// The frame element and its document must share a colour scheme, or the browser paints the frame opaque.
	frame.style.colorScheme = dark ? "dark" : "light";
	const entry: WidgetFrameEntry = {
		frame,
		source,
		documentText: widgetDocument(source, palette, dark, motion),
	};
	frame.src = WIDGET_FRAME_URL;
	figure.prepend(frame);
	const view = frame.contentWindow;
	if (view) widgetFrames.set(view, entry);
	if (title) {
		const header = document.createElement("div");
		header.className = "tr-fig-widget-head";
		const heading = document.createElement("strong");
		heading.textContent = title;
		const reset = document.createElement("button");
		reset.type = "button";
		reset.className = "tr-fig-widget-reset";
		reset.textContent = "Reset";
		reset.setAttribute("aria-label", `Reset ${title}`);
		reset.addEventListener("click", () => {
			frame.src = WIDGET_FRAME_URL;
		});
		header.append(heading, reset);
		figure.prepend(header);
	}
	figure.classList.add("tr-fig--drawn");
}

function waitingNote(figure: HTMLElement, text: string): void {
	if (figure.querySelector(":scope > .tr-fig-note")) return;
	const note = document.createElement("div");
	note.className = "tr-fig-note";
	note.textContent = text;
	figure.prepend(note);
}

/**
 * Draw every figure placeholder under `root`. `final` is false while the reply streams: widgets wait for the end
 * (a frame would reload on every token), Mermaid and charts draw once their source is complete, and an SVG draws
 * as it arrives. Re-running is cheap: a figure already drawn for the same source and theme is left alone.
 */
export function hydrateFigures(root: HTMLElement, final: boolean): void {
	const figures = root.querySelectorAll<HTMLElement>(".tr-fig[data-fig]");
	if (figures.length === 0) return;
	const palette = figurePalette(root);
	const dark = isDarkTheme();
	const motion = widgetMotion();
	const themeKey = `${dark ? "d" : "l"}:${JSON.stringify(palette)}`;
	const widgetThemeKey = `${themeKey}:${JSON.stringify(motion)}`;
	for (const figure of figures) {
		const kind = figure.dataset.fig as FigureKind;
		const source = figure.dataset.src ?? "";
		const closed = figure.dataset.closed === "1";
		const key = `${kind === "widget" ? widgetThemeKey : themeKey}:${final ? 1 : 0}`;
		if (kind === "widget" && figure.dataset.drawnFor !== undefined) {
			if (figure.dataset.drawnFor !== key) {
				const frame = figure.querySelector<HTMLIFrameElement>(":scope > iframe.tr-fig-frame");
				const view = frame?.contentWindow;
				const entry = view ? widgetFrames.get(view) : undefined;
				if (entry) updateWidgetTheme(entry, palette, dark, motion);
				figure.dataset.drawnFor = key;
			}
			continue;
		}
		if (figure.dataset.drawnFor === key) continue;
		switch (kind) {
			case "svg": {
				const svg = closed ? source : closePartialSvg(source);
				if (svg === null) break;
				showImage(figure, prepareSvg(svg, palette), "Figure");
				if (closed) tuckSource(figure);
				figure.dataset.drawnFor = key;
				break;
			}
			case "chart": {
				const svg = tableChartSvg(source);
				if (svg === null) {
					figure.remove();
					break;
				}
				figure.dataset.chartable = "true";
				showImage(figure, prepareSvg(svg, palette), "Chart of the table above");
				figure.dataset.drawnFor = key;
				break;
			}
			case "mermaid": {
				if (!closed) break;
				figure.dataset.drawnFor = key;
				void renderDiagram(source.trim(), palette, dark).then(
					svg => {
						if (figure.dataset.drawnFor !== key) return;
						showImage(figure, svg, "Diagram");
						tuckSource(figure);
					},
					() => figure.classList.add("tr-fig--failed"),
				);
				break;
			}
			case "widget": {
				if (!closed || !final) {
					waitingNote(figure, closed ? "Interactive widget — opens when the reply finishes." : "Interactive widget — still being written.");
					break;
				}
				figure.querySelector(":scope > .tr-fig-note")?.remove();
				showWidget(figure, source, palette, dark, motion, figure.dataset.title);
				tuckSource(figure);
				figure.dataset.drawnFor = key;
				break;
			}
		}
	}
}

/** Re-draw figures and recolour running widgets when appearance, palette, motion, or system preferences change. */
export function onThemeChange(callback: () => void): () => void {
	const observer = new MutationObserver(callback);
	observer.observe(document.documentElement, {
		attributes: true,
		attributeFilter: ["data-theme", "data-palette", "data-motion"],
	});
	const appearance = window.matchMedia("(prefers-color-scheme: light)");
	const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
	appearance.addEventListener("change", callback);
	reducedMotion.addEventListener("change", callback);
	return () => {
		observer.disconnect();
		appearance.removeEventListener("change", callback);
		reducedMotion.removeEventListener("change", callback);
	};
}
