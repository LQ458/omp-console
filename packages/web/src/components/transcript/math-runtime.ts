import { renderToString } from "katex";
import { escapeHtml } from "../../lib/format";
import { polishMathML } from "./math";

/** Render one equation using the transcript's MathML rules. */
export function renderMathHtml(source: string, raw: string, display: boolean): string {
	try {
		const math = polishMathML(
			renderToString(source, {
				displayMode: display,
				// KaTeX's HTML output needs katex.min.css, which bundles to ~940 KB
				// gzipped here because Bun inlines its 60 @font-face sources.
				output: "mathml",
				throwOnError: false,
				// `trust: false` refuses \href, \htmlClass, \includegraphics.
				strict: false,
				trust: false,
			}),
		);
		// A display equation gets a wrapper to scroll in (`.tr-math`), because
		// scrolling the `math` element itself traps a few pixels of vertical scroll:
		// its ink — fraction bars, radical overlines — overflows its own box.
		return display ? `<span class="tr-math">${math}</span>` : math;
	} catch {
		// KaTeX threw outside its own error handling (e.g. macro expansion limit): show the source.
		return escapeHtml(raw);
	}
}

/** Replace math placeholders after Markdown is in the DOM; KaTeX stays out of the entry chunk. */
export function hydrateMath(root: ParentNode): void {
	for (const pending of root.querySelectorAll<HTMLElement>("[data-math-src][data-math-raw][data-math-display]")) {
		const source = pending.dataset.mathSrc;
		const raw = pending.dataset.mathRaw;
		if (source === undefined || raw === undefined) continue;
		pending.outerHTML = renderMathHtml(source, raw, pending.dataset.mathDisplay === "1");
	}
}
