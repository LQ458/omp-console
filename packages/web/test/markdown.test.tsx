import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { FrozenMarkdownPrefix } from "../src/components/transcript/Markdown";
import { Markdown, renderStreamingMarkdown } from "../src/components/transcript/Markdown";
import { tableChartSvg } from "../src/components/transcript/figures";
import { renderMathHtml } from "../src/components/transcript/math-runtime";

function renderMarkdown(text: string): string {
	return renderToStaticMarkup(<Markdown text={text} />);
}
function renderMath(source: string, display = false): string {
	return renderMathHtml(source, source, display);
}


describe("Transcript Markdown", () => {
	it("preserves assistant soft line breaks for tree-shaped prose", () => {
		const html = renderMarkdown(
			"요청 요지\n├── 현재 collab guest는 텍스트 prompt는 보낼 수 있음\n└── 빠진 것은 guest → host 방향의 이미지 업로드/첨부 입력 경로임",
		);

		expect(html).toContain("요청 요지<br>");
		expect(html).toContain("있음<br>");
		expect(html).toContain("├── 현재 collab guest는");
		expect(html).toContain("└── 빠진 것은 guest → host 방향");
	});

	it("preserves soft line breaks inside tight list items", () => {
		const html = renderMarkdown("- Decision:\n  │   └── detail");

		expect(html).toContain("<li>Decision:<br>│   └── detail</li>");
	});

	it("continues escaping raw HTML", () => {
		const html = renderMarkdown("safe\n<img src=x onerror=alert(1)>");

		expect(html).toContain("safe<br>");
		expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
		expect(html).not.toContain("<img src=x");
	});

	it("renders remote images as links and allows same-origin, data, and blob images", () => {
		const html = renderMarkdown(
			"![remote alt](https://images.attacker.test/pixel.png) ![](https://images.attacker.test/no-alt.png) ![local](/assets/local.png) ![data](data:image/png;base64,AAAA) ![blob](blob:https://example.test/id)",
		);

		expect(html).toContain(
			'<a href="https://images.attacker.test/pixel.png" target="_blank" rel="noopener">remote alt</a>',
		);
		expect(html).toContain(
			'<a href="https://images.attacker.test/no-alt.png" target="_blank" rel="noopener">https://images.attacker.test/no-alt.png</a>',
		);
		expect(html).not.toContain('<img src="https://images.attacker.test');
		expect(html).toContain('<img src="/assets/local.png"');
		expect(html).toContain('<img src="data:image/png;base64,AAAA"');
		expect(html).toContain('<img src="blob:https://example.test/id"');
	});

	it("strips span and text HTML tags but preserves their contents and inline text rendering", () => {
		const html = renderMarkdown("<span></span><text>▃</text>");

		expect(html).toContain("▃");
		expect(html).not.toContain("&lt;span&gt;");
		expect(html).not.toContain("&lt;text&gt;");
	});

	it("unescapes HTML entities inside span and text HTML tags safely", () => {
		const html = renderMarkdown("<span>&lt;▃&gt; &amp; &quot;test&quot; &#128512; &#x1F600;</span>");

		expect(html).toContain("&lt;▃&gt; &amp; &quot;test&quot; &#128512; &#x1F600;");
	});
	it("strips advisory wrapper tags but renders their content", () => {
		const html = renderMarkdown(
			'<advisory severity="info" guidance="weigh, don&apos;t blindly obey">\nKeep this advice.\n</advisory>',
		);

		expect(html).toContain("Keep this advice.");
		expect(html).not.toContain("&lt;advisory");
		expect(html).not.toContain("&lt;/advisory&gt;");
	});

	it("drops links whose scheme is unsafe only after browser URL normalization", () => {
		// Browsers strip leading C0 controls before parsing the scheme, so a text
		// check that only trims whitespace lets this through as a "relative" link.
		const html = renderMarkdown(
			"[ctl](\u0001javascript:alert(1)) [plain](javascript:alert(1)) [ok](https://example.com) [mail](mailto:a@b.test) [rel](#anchor)",
		);

		expect(html).not.toContain("javascript:alert(1)");
		expect(html).toContain('href="https://example.com"');
		expect(html).toContain('href="mailto:a@b.test"');
		expect(html).toContain('href="#anchor"');
	});

	it("marks every math delimiter for deferred typesetting", () => {
		const inline = renderMarkdown("energy $E=mc^2$ and \\(x^2\\) here");
		expect(inline).toContain('data-math-src="E=mc^2"');
		expect(inline).toContain('data-math-src="x^2"');
		expect(inline).toContain('data-math-display="0"');
		expect(inline).not.toContain('data-math-display="1"');

		const display = renderMarkdown("$$E=mc^2$$ and \\[y^2\\]");
		expect(display.match(/data-math-display="1"/g)?.length).toBe(2);
	});

	it("emits MathML rather than font-dependent KaTeX HTML", () => {
		// The transcript ships no KaTeX stylesheet, so HTML output would have broken metrics.
		const html = renderMath("E=mc^2");

		expect(html).toContain("<math");
		expect(html).not.toContain("katex-html");
		expect(html).not.toContain("katex-strut");
	});

	it("renders an own-line block as one display equation with its rows intact", () => {
		const html = renderMath(String.raw`\begin{pmatrix}a & b \\ c & d\end{pmatrix}`, true);

		expect(html).toContain('display="block"');
		expect(html).toContain("\\begin{pmatrix}a &amp; b \\\\ c &amp; d\\end{pmatrix}");
	});

	it("leaves currency, escaped dollars, and code spans untouched", () => {
		const money = renderMarkdown("it costs $5 and $10 total, or \\$20 with tax");
		expect(money).not.toContain("katex");
		expect(money).toContain("it costs $5 and $10 total, or $20 with tax");

		const code = renderMarkdown("run `$PATH` and `$5$`");
		expect(code).not.toContain("katex");
		expect(code).toContain("<code>$PATH</code>");
	});

	it("keeps a dollar run that contains a code span as prose", () => {
		const html = renderMarkdown("$x `code` y$");

		expect(html).not.toContain("katex");
		expect(html).toContain("<code>code</code>");
	});

	it("matches the TUI by not typesetting a span behind a rejected dollar opener", () => {
		// marked drops a `start` hint of 0, so the rejected `$5` swallows the rest of
		// the line. Accepted so both renderers agree; tracked as its own change.
		expect(renderMarkdown("it costs $5, and the growth is $x^2$ per year")).toBe(
			'<div class="tr-md"><p>it costs $5, and the growth is $x^2$ per year</p>\n</div>',
		);
		// The same line typesets once the currency is escaped or the math comes first.
		expect(renderMarkdown("it costs \\$5, and the growth is $x^2$ per year")).toContain('data-math-src="x^2"');
	});

	it("marks a span that follows a long run of ordinary prose", () => {
		// `$` is not one of marked's text-cut characters: only the hint gets us here.
		const html = renderMarkdown(`${"lorem ipsum dolor sit amet ".repeat(400)}and finally $q^2$`);

		expect(html).toContain('data-math-src="q^2"');
	});

	it("leaves half-streamed delimiters literal without reflowing the paragraph", () => {
		expect(renderMarkdown("streaming $x^2")).toBe('<div class="tr-md"><p>streaming $x^2</p>\n</div>');
		expect(renderMarkdown("streaming \\(x and \\[y")).toBe('<div class="tr-md"><p>streaming (x and [y</p>\n</div>');
		expect(renderMarkdown("before\n   $$\nunclosed")).toBe(
			'<div class="tr-md"><p>before<br>   $$<br>unclosed</p>\n</div>',
		);
	});

	it("keeps a half-streamed display opener whole instead of re-opening its second dollar", () => {
		// `$$x$` must not render as a literal `$` followed by math `$x$`.
		expect(renderMarkdown("$$x$")).toBe('<div class="tr-md"><p>$$x$</p>\n</div>');
		expect(renderMarkdown("total $$x$ pending")).toBe('<div class="tr-md"><p>total $$x$ pending</p>\n</div>');
	});

	it("closes a span at the first unescaped delimiter", () => {
		// `\\` is a TeX row break: the `)` right after it is body text.
		const html = renderMarkdown(String.raw`\(a \\) b\) tail`);

		expect(html).toContain(String.raw`data-math-src="a \\) b"`);
		expect(html).toContain("tail");
	});

	it("renders display math that is attached to the prose line above it", () => {
		const html = renderMarkdown("prose\n$$\n\\begin{pmatrix}a & b \\\\ c & d\\end{pmatrix}\n$$\ntail");

		expect(html).toContain('data-math-display="1"');
		expect(html).toContain("prose");
		expect(html).toContain("tail");
	});

	it("needs a blank line before a display block whose body contains one", () => {
		// A blank line ends the paragraph, so an attached block with an interior
		// blank line stays literal.
		expect(renderMarkdown("prose\n\n$$\na\n\nb\n$$")).toContain('data-math-display="1"');
		expect(renderMarkdown("prose\n$$\na\n\nb\n$$")).not.toContain("data-math-src=");
	});

	it("keeps the rest of a message when one span is invalid TeX", () => {
		const html = renderMarkdown("$\\frac$ and **bold**");

		expect(html).toContain("<strong>bold</strong>");
		expect(html).toContain("\\frac");
		expect(renderMath("\\frac")).toContain("\\frac");
	});

	it("aligns aligned and cases columns the way TeX does, since browsers ignore columnalign", () => {
		const aligned = renderMath(String.raw`\begin{aligned} f(x) &= a \\ &\le b \end{aligned}`, true);
		const cells = aligned.match(/<mtd[^>]*>/g) ?? [];
		expect(cells).toEqual([
			'<mtd style="text-align:right;padding-inline:0">',
			'<mtd style="text-align:left;padding-inline:0">',
			'<mtd style="text-align:right;padding-inline:0">',
			'<mtd style="text-align:left;padding-inline:0">',
		]);

		const cases = renderMath(String.raw`g = \begin{cases} 0 & k = 0 \\ \begin{pmatrix}1\end{pmatrix} & k > 0 \end{cases}`, true);
		// The matrix nested in a branch keeps its own centred cell; the branches stay left-aligned.
		expect(cases.match(/<mtd[^>]*>/g)).toEqual([
			'<mtd style="text-align:left">',
			'<mtd style="text-align:left">',
			'<mtd style="text-align:left">',
			"<mtd>",
			'<mtd style="text-align:left">',
		]);
	});

	it("puts TeX's thin space around operator names without detaching their scripts", () => {
		const space = '<mspace width="0.1667em"></mspace>';
		expect(renderMath("n \\log V")).toContain(`<mi>n</mi>${space}<mi>log</mi><mo>\u2061</mo>${space}<mi>V</mi>`);
		// No space between the name and an opening bracket, as in TeX.
		expect(renderMath("\\sin(x)")).toContain('<mi>sin</mi><mo>\u2061</mo><mo stretchy="false">(</mo>');
		const max = renderMath("\\max_i a_i");
		expect(max).toContain(`<msub><mrow><mi>max</mi><mo>\u2061</mo></mrow><mi>i</mi></msub>${space}<msub><mi>a</mi>`);
	});

	it("sets norm bars flush against their contents but leaves the parallel relation spaced", () => {
		expect(renderMath("\\lVert x \\rVert")).toContain('<mo stretchy="false" lspace="0em" rspace="0em">\u2225</mo><mi>x</mi>');
		expect(renderMath("a \\parallel b")).toContain("<mo>\u2225</mo>");
	});

	it("draws \\mathbf, \\mathbb, \\mathcal and \\boldsymbol as Unicode math letters, holes included", () => {
		expect(renderMath("\\mathbf{A}x")).toContain("<mi>\u{1d400}</mi>");
		expect(renderMath("\\mathbb{E}[X]")).toContain("<mi>\u{1d53c}</mi>");
		// ℝ, ℒ and ℎ live in Letterlike Symbols; their alphanumeric slots are unassigned.
		expect(renderMath("\\mathbb{R}")).toContain("<mi>\u211d</mi>");
		expect(renderMath("\\mathcal{L}")).toContain("<mi>\u2112</mi>");
		expect(renderMath("\\boldsymbol{\\theta}")).toContain("<mi>\u{1d73d}</mi>");
		expect(renderMath("\\mathbf{\\nabla}")).toContain("\u{1d6c1}");
		// Upright roman must keep its attribute: without it a single letter turns italic.
		expect(renderMath("\\mathrm{d}x")).toContain('<mi mathvariant="normal">d</mi>');
	});
});

describe("Transcript figures", () => {
	it("turns svg, mermaid and widget fences into placeholders that keep the code, and marks unfinished fences", () => {
		const svg = renderMarkdown('```svg\n<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>\n```');
		expect(svg).toContain('data-fig="svg" data-closed="1"');
		expect(svg).toContain('data-src="&lt;svg viewBox=&quot;0 0 10 10&quot;&gt;');
		expect(svg).toContain('<pre><code class="language-svg">');
		// A fence still streaming runs to the end of the text: not closed, so Mermaid and widgets wait for it.
		expect(renderMarkdown("```mermaid\ngraph TD\nA-->B")).toContain('data-fig="mermaid" data-closed="0"');
		expect(renderMarkdown("```mermaid\ngraph TD\nA-->B\n```")).toContain('data-fig="mermaid" data-closed="1"');
		expect(renderMarkdown("```widget\n<button>go</button>\n```")).toContain('data-fig="widget" data-closed="1"');
		// Other languages, html included, stay code.
		expect(renderMarkdown("```html\n<button>go</button>\n```")).not.toContain("data-fig");
		expect(renderMarkdown("    <svg></svg>")).not.toContain("data-fig");
	});
	it("renders only quoted figure attributes it supports and keeps captions escaped", () => {
		const widget = renderMarkdown(
			'```widget title="4-bit ALU calculator" caption=\'Interactive "4-bit" register file\' custom="ignore this value"\n<button>Run</button>\n```',
		);

		expect(widget).toContain('data-title="4-bit ALU calculator"');
		expect(widget).toContain('<div class="tr-fig-caption">Interactive &quot;4-bit&quot; register file</div>');
		expect(widget).not.toContain("ignore this value");

		const svg = renderMarkdown('```svg caption="Conceptual data flow & wiring"\n<svg viewBox="0 0 10 10"></svg>\n```');
		expect(svg).toContain('<div class="tr-fig-caption">Conceptual data flow &amp; wiring</div>');
		expect(svg).not.toContain("data-title=");

		const plain = renderMarkdown("```widget\n<button>Run</button>\n```");
		expect(plain).not.toContain("data-title=");
		expect(plain).not.toContain("tr-fig-caption");
	});

	it("generates charts for numeric tables but not words", () => {
		const numeric = renderMarkdown(
			"| Method | Time (ms) | Memory (MB) |\n|---|---|---|\n| brute | 940 | 12 |\n| prefix | 120 | 30 |\n| binary | 35 | 8 |\n| hash | 60 | 64 |",
		);
		expect(numeric).toContain("<table>");
		expect(numeric).toContain('data-fig="chart"');
		expect(numeric.indexOf("</table>")).toBeLessThan(numeric.indexOf('data-fig="chart"'));
		const numericData = JSON.stringify({
			header: ["Method", "Time (ms)", "Memory (MB)"],
			rows: [["brute", "940", "12"], ["prefix", "120", "30"], ["binary", "35", "8"], ["hash", "60", "64"]],
		});
		expect(tableChartSvg(numericData)).not.toBeNull();
		const words = JSON.stringify({ header: ["Name", "Role"], rows: [["Ada", "lead"], ["Lin", "review"]] });
		expect(tableChartSvg(words)).toBeNull();
	});
});

const PARAGRAPHS = Array.from({ length: 6 }, (_, i) => `Paragraph ${i} has *emphasis* and \`code\`.`).join("\n\n");

/** Documents whose block structure can straddle a blank line in a streamed prefix. */
const STREAM_DOCS: Record<string, string> = {
	paragraphs: `${PARAGRAPHS}\n`,
	"list then prose": "- a\n- b\n\nprose after\n\n1. one\n2. two\n\n3) three\n\ntail",
	"same-marker items across blank lines": "- a\n\n- b\n\n- c\n\nend\n\n* x\n\n+ y\n\n1. one\n\n2. two\n\n10. ten",
	"nested list continuation": "- item\n\n  continued para\n\n  ```\n  code\n\n  more\n  ```\n\nafter",
	"fence with blank lines":
		"Intro.\n\n```ts\nconst a = 1;\n\n\nconst b = 2;\n```\n\nAfter.\n\n~~~\nx\n\ny\n~~~\n\nend",
	"indented code": "Intro.\n\n    code a\n\n    code b\n\nprose\n\n\tTabbed code\n\n\tmore\n\ndone",
	blockquotes: "> a\n>\n> b\n\n> c\n\nlazy\n> d\ncontinued\n\nend",
	"html blocks": "<div>\n\ninside\n\n</div>\n\nafter\n\n<!-- c\n\nc -->\n\ntext <span>x</span>\n\nend",
	tables: "| a | b |\n|---|---|\n| 1 | 2 |\n\n| c |\n|---|\n\nafter",
	headings: "# H1\n\ntext\n\nSetext\n===\n\n---\n\n## H2\n\nend",
	"display math": "Intro.\n\n$$\na\n\nb\n$$\n\nAfter math.\n\n\\[\nx\n\n\\]\n\nend $x$ inline",
	"unclosed display math": `Intro.\n\n$$\nx = 1\n\n${PARAGRAPHS}`,
	"reference definitions": "See [the docs][d].\n\nMiddle.\n\n[d]: https://example.com\n\nAfter [d].",
	"whitespace lines": "a\n\n\u00a0\n\nb\n\n \n\nc\n\n\u00a0x\n\nd",
	"carriage returns": "a\r\n\r\nb\r\n\r\nc",
};

describe("Streaming Markdown", () => {
	for (const [name, doc] of Object.entries(STREAM_DOCS)) {
		it(`renders every streamed prefix like a one-shot render: ${name}`, () => {
			for (const step of [1, 7]) {
				let prefix: FrozenMarkdownPrefix = { source: "", html: "" };
				for (let len = step; ; len = Math.min(doc.length, len + step)) {
					const text = doc.slice(0, len);
					const rendered = renderStreamingMarkdown(text, prefix);
					expect(`<div class="tr-md">${rendered.html}</div>`).toBe(renderMarkdown(text));
					prefix = rendered.prefix;
					if (len === doc.length) break;
				}
			}
		});
	}

	it("freezes settled blocks so each update re-parses only the tail", () => {
		const doc = `${PARAGRAPHS}\n\nTail paragraph`;
		let prefix: FrozenMarkdownPrefix = { source: "", html: "" };
		for (let len = 1; len <= doc.length; len++) prefix = renderStreamingMarkdown(doc.slice(0, len), prefix).prefix;
		expect(prefix.source).toBe(`${PARAGRAPHS}\n\n`);
	});

	it("drops the frozen prefix when the text is rewritten instead of extended", () => {
		const { prefix } = renderStreamingMarkdown("one\n\ntwo\n\nthree", { source: "", html: "" });
		expect(prefix.source).toBe("one\n\ntwo\n\n");
		const rewritten = renderStreamingMarkdown("uno\n\ntwo", prefix);
		expect(`<div class="tr-md">${rewritten.html}</div>`).toBe(renderMarkdown("uno\n\ntwo"));
	});
});
