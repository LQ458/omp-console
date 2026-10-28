/**
 * Visuals in assistant Markdown, the ones omp's system prompt invites (`tui.renderSvg`, `tui.renderMermaid`,
 * `tui.autoGraph`) plus deck's interactive widgets:
 *
 *  - ```svg   drawn as an image in the reader's theme (omp's `prepareSvg` resolves the figure tokens);
 *  - ```mermaid   drawn as a diagram by the vendored Mermaid build, once the fence is closed;
 *  - a numeric table   gets omp's own chart under it (`planChart` → `renderChartSvg`, the TUI's auto-graph);
 *  - ```widget   a self-contained HTML document run in a sandboxed frame, once the reply has finished.
 *
 * Rendering is two-step because transcript Markdown is an HTML string: the marked extension below writes a
 * placeholder holding the source (with the fence as a code block, so copy and plain rendering keep working), and
 * {@link hydrateFigures} turns placeholders into visuals after the string is in the DOM.
 *
 * Isolation: agent SVG and Mermaid output are shown through `<img>` (an image document runs no script and loads
 * nothing), never inlined. A widget runs in an iframe with `sandbox="allow-scripts"` only (opaque origin: no deck
 * cookies, storage or API), loaded from the daemon's `/widget-frame.html`, whose own CSP forbids every network
 * fetch; the frame's parent posts it the document.
 */
import type { MarkedExtension, Tokens } from "@oh-my-pi/pi-utils/marked";
import { escapeHtml } from "../../lib/format";

export type FigureKind = "svg" | "mermaid" | "widget" | "chart";


/** A fence is closed when its raw text ends on a closing fence line (a streaming fence runs to the end of the text). */
function fenceClosed(raw: string): boolean {
	const lines = raw.replace(/\n+$/, "").split("\n");
	if (lines.length < 2) return false;
	const open = /^ {0,3}(`{3,}|~{3,})/.exec(lines[0]!)?.[1];
	const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines.at(-1)!)?.[1];
	return open !== undefined && close !== undefined && close[0] === open[0] && close.length >= open.length;
}

interface FigureInfo {
	kind: FigureKind;
	caption?: string;
	title?: string;
}

function figureInfo(lang: string | undefined): FigureInfo | undefined {
	const raw = (lang ?? "").trim();
	const match = /^([^\s]+)/.exec(raw);
	if (!match) return undefined;
	const word = match[1]!.toLowerCase();
	if (word !== "svg" && word !== "mermaid" && word !== "widget") return undefined;

	let caption: string | undefined;
	let title: string | undefined;
	let index = match[0].length;
	while (index < raw.length) {
		while (/\s/.test(raw[index] ?? "")) index++;
		const keyStart = index;
		while (index < raw.length && !/[\s=]/.test(raw[index]!)) index++;
		if (keyStart === index) break;
		const key = raw.slice(keyStart, index);
		while (/\s/.test(raw[index] ?? "")) index++;
		if (raw[index] !== "=") {
			while (index < raw.length && !/\s/.test(raw[index]!)) index++;
			continue;
		}
		index++;
		while (/\s/.test(raw[index] ?? "")) index++;
		let value = "";
		const quote = raw[index] === '"' || raw[index] === "'" ? raw[index]! : undefined;
		if (quote) {
			index++;
			let closed = false;
			while (index < raw.length) {
				const char = raw[index]!;
				if (char === "\\" && index + 1 < raw.length && (raw[index + 1] === quote || raw[index + 1] === "\\")) {
					value += raw[index + 1]!;
					index += 2;
				} else if (char === quote) {
					index++;
					closed = true;
					break;
				} else {
					value += char;
					index++;
				}
			}
			if (!closed) continue;
		} else {
			const valueStart = index;
			while (index < raw.length && !/\s/.test(raw[index]!)) index++;
			value = raw.slice(valueStart, index);
		}
		if (key === "caption") caption = value;
		else if (key === "title") title = value;
	}

	const info: FigureInfo = { kind: word };
	if (caption !== undefined) info.caption = caption;
	if (title !== undefined) info.title = title;
	return info;
}

function placeholder(kind: FigureKind, source: string, closed: boolean, inner: string, info?: FigureInfo): string {
	const title = info?.title ? ` data-title="${escapeHtml(info.title)}"` : "";
	const caption = info?.caption ? `<div class="tr-fig-caption">${escapeHtml(info.caption)}</div>` : "";
	return `<div class="tr-fig tr-fig--${kind}" data-fig="${kind}" data-closed="${closed ? "1" : "0"}" data-src="${escapeHtml(source)}"${title}>${inner}${caption}</div>\n`;
}


/** The marked side: figure placeholders and deferred table-chart data. */
export const figureExtension: MarkedExtension = {
	extensions: [
		{
			name: "code",
			renderer(token) {
				const code = token as Tokens.Code;
				const info = figureInfo(code.lang);
				if (info === undefined || code.codeBlockStyle === "indented") return false;
				const fallback = this.parser.renderer.code({ ...code, lang: info.kind });
				return placeholder(info.kind, code.text, fenceClosed(code.raw), fallback, info);
			},
		},
		{
			name: "table",
			renderer(token) {
				const table = token as Tokens.Table;
				const html = this.parser.renderer.table(table);
				const chart = {
					header: table.header.map(cell => cell.text),
					rows: table.rows.map(row => row.map(cell => cell.text)),
				};
				// Chartability and rendering are deferred with the figure runtime.
				return html + placeholder("chart", JSON.stringify(chart), true, "");
			},
		},
	],
};

