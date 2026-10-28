import { describe, expect, it } from "bun:test";
import { copyCommandCode, copyableMessageText, extractFencedCodeBlocks, lastHttpLink, openExternalLink } from "../src/components/transcript/clipboard";

describe("transcript copy and link actions", () => {
	it("copies only visible text blocks and preserves their order", () => {
		expect(copyableMessageText([
			{ type: "thinking", text: "private reasoning" },
			{ type: "text", text: "Answer" },
			{ type: "toolCall" },
			{ type: "text", text: "Second paragraph" },
			{ type: "image" },
		])).toBe("Answer\nSecond paragraph");
	});

	it("opens the last valid HTTP(S) link and excludes trailing punctuation", () => {
		expect(lastHttpLink("First https://example.com/a, then https://docs.example.org/guide.)")).toBe("https://docs.example.org/guide");
		const opened: string[] = [];
		expect(openExternalLink("See https://example.com/help.", url => opened.push(url))).toBe(true);
		expect(opened).toEqual(["https://example.com/help"]);
		expect(lastHttpLink("javascript:alert(1) and data:text/plain,unsafe")).toBeNull();
		expect(openExternalLink("no link", url => opened.push(url))).toBe(false);
	});

	it("extracts complete fenced code blocks and ignores an unclosed fence", () => {
		expect(extractFencedCodeBlocks("Answer\n```ts\nconst x = 1;\n```\n```py\nprint(x)\n```\n```sh\nincomplete")).toEqual([
			"const x = 1;",
			"print(x)",
		]);
	});

	it("copies runnable bash and joined eval cells, but not unrelated tools", () => {
		expect(copyCommandCode("bash", { command: "printf 'ok\\n'" })).toBe("printf 'ok\\n'");
		expect(copyCommandCode("eval", { cells: [{ code: "one()" }, { code: "", language: "js" }, { code: "two()" }] })).toBe("one()\n\ntwo()");
		expect(copyCommandCode("write", { path: "x" })).toBeNull();
	});
});
