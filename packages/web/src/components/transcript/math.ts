import type { MarkedExtension, Tokens } from "@oh-my-pi/pi-utils/marked";
import {
	type MathSpan,
	mathBlockInContext,
	mathSpanInContext,
	mathStartIndex,
} from "@oh-my-pi/pi-utils/math-delimiters";
import { escapeHtml } from "../../lib/format";

/**
 * A backtick between the delimiters means the run is prose that merely looks
 * like math (`$x `code` y$`): KaTeX cannot express a code span, so typesetting
 * would swallow it and print an error instead.
 */
function typesettable(span: MathSpan): boolean {
	return !span.body.includes("`");
}

const THIN_SPACE = '<mspace width="0.1667em"></mspace>';

/**
 * MathML Core (WebKit, Chromium) ignores `columnalign` and `columnspacing` on
 * `mtable`, so `aligned` centres both sides of every `&=` and `cases` centres
 * its branches. Each cell gets its column's alignment as an inline style; a
 * table KaTeX marks with zero column spacing (`aligned`) also drops the
 * user-agent cell padding, which would otherwise open a gap at the `&`.
 * KaTeX escapes all TeX text, so every `<mtable|mtr|mtd` here is a real tag.
 */
function alignTableCells(math: string): string {
	const tables: { aligns: string[]; tight: boolean; col: number }[] = [];
	return math.replace(/<(\/?)(mtable|mtr|mtd)\b([^>]*)>/g, (tag, close: string, name: string, attrs: string) => {
		if (name === "mtable") {
			if (close) tables.pop();
			else
				tables.push({
					aligns: /columnalign="([^"]*)"/.exec(attrs)?.[1]?.split(/\s+/) ?? [],
					tight: /columnspacing="0em"/.test(attrs),
					col: 0,
				});
			return tag;
		}
		const table = tables.at(-1);
		if (!table || close) return tag;
		if (name === "mtr") {
			table.col = 0;
			return tag;
		}
		const align = table.aligns.length > 0 ? table.aligns[table.col % table.aligns.length] : "center";
		table.col++;
		const style = [align === "left" || align === "right" ? `text-align:${align}` : "", table.tight ? "padding-inline:0" : ""]
			.filter(Boolean)
			.join(";");
		return style && !attrs.includes("style=") ? `<mtd style="${style}"${attrs}>` : tag;
	});
}

/**
 * Operator names (`\log`, `\det`, `\max`) come out as `<mi>log</mi><mo>⁡</mo>`,
 * and browsers give the invisible function-application operator no width, so
 * `O(n \log V)` prints "nlogV". Restore TeX's thin spaces: before the name when
 * an ordinary atom precedes it, and after it unless an operator (an opening
 * bracket, a relation) follows. A scripted name (`\max_i`) is spaced after its
 * whole script element, so the subscript stays attached.
 */
function spaceOperatorNames(math: string): string {
	return math
		.replace(
			/(<\/(?:mi|mn|msub|msup|msubsup|mrow)>)?(<mi(?: mathvariant="normal")?>[^<]{2,}<\/mi>)<mo>\u2061<\/mo>(?!<\/mrow>|<mo)/g,
			(_m, prev: string | undefined, name: string) => `${prev ? prev + THIN_SPACE : ""}${name}<mo>\u2061</mo>${THIN_SPACE}`,
		)
		.replace(
			/(<(msub|msup|msubsup|munder|munderover)><mrow><mi(?: mathvariant="normal")?>[^<]{2,}<\/mi><mo>\u2061<\/mo><\/mrow>(?:(?!<\2[ >])[\s\S])*?<\/\2>)(?!<mo|<\/mrow>)/g,
			`$1${THIN_SPACE}`,
		);
}

/**
 * `\lvert`/`\lVert` are opening and closing delimiters in TeX, but KaTeX emits
 * them as `<mo stretchy="false">∣</mo>`, and the browser operator dictionary
 * spaces U+2223/U+2225 like the relations "divides"/"parallel", so `\lVert
 * \theta \rVert` prints "∥ θ ∥". The relations themselves (`\mid`, `\parallel`)
 * carry no `stretchy` attribute and keep their spacing.
 */
function tightenBarDelimiters(math: string): string {
	return math.replace(/<mo stretchy="false">([∣∥])<\/mo>/g, '<mo stretchy="false" lspace="0em" rspace="0em">$1</mo>');
}

/** First code points of each Mathematical Alphanumeric Symbols run: A, a, 0, Α, α. */
const ALPHANUMERIC: Record<string, [number, number, number?, number?, number?]> = {
	bold: [0x1d400, 0x1d41a, 0x1d7ce, 0x1d6a8, 0x1d6c2],
	italic: [0x1d434, 0x1d44e, undefined, 0x1d6e2, 0x1d6fc],
	"bold-italic": [0x1d468, 0x1d482, undefined, 0x1d71c, 0x1d736],
	script: [0x1d49c, 0x1d4b6],
	"bold-script": [0x1d4d0, 0x1d4ea],
	fraktur: [0x1d504, 0x1d51e],
	"double-struck": [0x1d538, 0x1d552, 0x1d7d8],
	"bold-fraktur": [0x1d56c, 0x1d586],
	"sans-serif": [0x1d5a0, 0x1d5ba, 0x1d7e2],
	"bold-sans-serif": [0x1d5d4, 0x1d5ee, 0x1d7ec, 0x1d756, 0x1d770],
	"sans-serif-italic": [0x1d608, 0x1d622],
	"sans-serif-bold-italic": [0x1d63c, 0x1d656, undefined, 0x1d790, 0x1d7aa],
	monospace: [0x1d670, 0x1d68a, 0x1d7f6],
};

/** Letters Unicode encoded before the alphanumeric block, whose slots in it are holes. */
const LETTERLIKE: Record<string, Record<string, number>> = {
	italic: { h: 0x210e },
	script: { B: 0x212c, E: 0x2130, F: 0x2131, H: 0x210b, I: 0x2110, L: 0x2112, M: 0x2133, R: 0x211b, e: 0x212f, g: 0x210a, o: 0x2134 },
	fraktur: { C: 0x212d, H: 0x210c, I: 0x2111, R: 0x211c, Z: 0x2128 },
	"double-struck": { C: 0x2102, H: 0x210d, N: 0x2115, P: 0x2119, Q: 0x211a, R: 0x211d, Z: 0x2124 },
};

/** Lowercase Greek after ω in the alphanumeric runs: ∂ ϵ ϑ ϰ ϕ ϱ ϖ. */
const GREEK_TAIL = "\u2202\u03f5\u03d1\u03f0\u03d5\u03f1\u03d6";

function alphanumeric(variant: string, ch: string): string {
	const hole = LETTERLIKE[variant]?.[ch];
	if (hole !== undefined) return String.fromCodePoint(hole);
	const [upper, lower, digit, greekUpper, greekLower] = ALPHANUMERIC[variant]!;
	const code = ch.codePointAt(0)!;
	let mapped: number | undefined;
	if (code >= 0x41 && code <= 0x5a) mapped = upper + code - 0x41;
	else if (code >= 0x61 && code <= 0x7a) mapped = lower + code - 0x61;
	else if (code >= 0x30 && code <= 0x39 && digit !== undefined) mapped = digit + code - 0x30;
	else if (code >= 0x391 && code <= 0x3a9 && code !== 0x3a2 && greekUpper !== undefined) mapped = greekUpper + code - 0x391;
	else if (code === 0x3f4 && greekUpper !== undefined) mapped = greekUpper + 17;
	else if (code === 0x2207 && greekUpper !== undefined) mapped = greekUpper + 25;
	else if (code >= 0x3b1 && code <= 0x3c9 && greekLower !== undefined) mapped = greekLower + code - 0x3b1;
	else if (GREEK_TAIL.includes(ch) && greekLower !== undefined) mapped = greekLower + 25 + GREEK_TAIL.indexOf(ch);
	return mapped === undefined ? ch : String.fromCodePoint(mapped);
}

const TEXT_VARIANT_STYLE: Record<string, string> = {
	bold: "font-weight:bold",
	italic: "font-style:italic",
	"bold-italic": "font-weight:bold;font-style:italic",
	"sans-serif": "font-family:sans-serif",
	monospace: "font-family:monospace",
};

/**
 * MathML Core (Chromium, so the Android shell) supports only
 * `mathvariant="normal"`: `\mathbf{A}`, `\mathbb{E}`, `\mathcal{L}` and
 * `\boldsymbol\theta` would print as plain letters. Tokens get the matching
 * Mathematical Alphanumeric Symbols instead, which every engine draws the same;
 * `mtext` (`\textbf`) keeps its text and gets the CSS equivalent. Characters
 * outside the Latin, digit and Greek runs stay as they are.
 */
function mapVariants(math: string): string {
	return math.replace(
		/<(mi|mn|mo|mtext) mathvariant="([a-z-]+)">([^<]*)<\/\1>/g,
		(tag, name: string, variant: string, text: string) => {
			if (name === "mtext") {
				const style = TEXT_VARIANT_STYLE[variant];
				return style ? `<mtext style="${style}">${text}</mtext>` : tag;
			}
			if (!(variant in ALPHANUMERIC)) return tag;
			// `&amp;`-style entities are never letters; leave them intact.
			const mapped = text.replace(/&[a-z#0-9]+;|[^&]/giu, ch => (ch.length > 1 ? ch : alphanumeric(variant, ch)));
			return `<${name}>${mapped}</${name}>`;
		},
	);
}

export function polishMathML(math: string): string {
	return mapVariants(tightenBarDelimiters(spaceOperatorNames(alignTableCells(math))));
}

function renderMathPlaceholder(token: Tokens.Generic): string | false {
	if (token.type !== "math" || typeof token.text !== "string" || typeof token.display !== "boolean") return false;
	const raw = typeof token.raw === "string" ? token.raw : token.text;
	const className = token.display ? "tr-math tr-math-pending" : "tr-math-pending";
	return `<span class="${className}" data-math-src="${escapeHtml(token.text)}" data-math-raw="${escapeHtml(raw)}" data-math-display="${token.display ? "1" : "0"}">${escapeHtml(raw)}</span>`;
}

/**
 * Renders LaTeX in transcript Markdown: `$…$` and `\(…\)` inline, `$$…$$` and
 * `\[…\]` in display mode, plus own-line `$$`/`\[` blocks. Delimiters and the
 * scan hint come from `@oh-my-pi/pi-utils/math-delimiters`, so this renderer and
 * the TUI agree on what counts as math; only presentation policy lives here.
 *
 * Two limits follow from that shared behavior, both matching the TUI: a rejected
 * opener hides later spans on its line ("it costs $5, and the growth is $x^2$"
 * typesets nothing, since marked drops a start hint at its own position), and a
 * display block whose body contains a blank line must be preceded by one —
 * attached blocks are tokenized by the inline rule, which a blank line ends.
 */
export const mathExtension: MarkedExtension = {
	extensions: [
		{
			name: "math",
			level: "block",
			// No `start` hint: this parser probes block extensions only at a block
			// boundary and never consults their hints.
			tokenizer(source) {
				const block = mathBlockInContext(this, source);
				if (!block) return undefined;
				return { type: "math", raw: block.raw, text: block.body, display: true };
			},
			renderer: renderMathPlaceholder,
		},
		{
			name: "math",
			level: "inline",
			startFrom: mathStartIndex,
			tokenizer(source) {
				const span = mathSpanInContext(this, source);
				if (!span || !typesettable(span)) return undefined;
				return { type: "math", raw: source.slice(0, span.end), text: span.body, display: span.display };
			},
			renderer: renderMathPlaceholder,
		},
	],
};
