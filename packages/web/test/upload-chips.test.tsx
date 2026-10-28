import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { UploadChips } from "../src/components/composer/UploadChips";

describe("UploadChips", () => {
	it("shows byte progress while uploading and a dismissible error after failure", () => {
		const html = renderToStaticMarkup(
			<UploadChips
				uploads={[
					{ id: 1, name: "notes.pdf", size: 1536, loaded: 512 },
					{ id: 2, name: "private.txt", size: 9, loaded: 0, error: "not authorized" },
				]}
				onCancel={() => {}}
			/>,
		);

		expect(html).toContain('aria-label="uploading notes.pdf"');
		expect(html).toContain("1.5 KiB");
		expect(html).toContain('aria-valuetext="512 of 1536 bytes"');
		expect(html).toContain("not authorized");
		expect(html).toContain('aria-label="dismiss upload error for private.txt"');
	});
});
