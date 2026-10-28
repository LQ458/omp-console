import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const INDEX = path.resolve(import.meta.dir, "../index.html");

describe("index.html under the daemon's Content-Security-Policy", () => {
	test("has no inline script (script-src 'self' would refuse it and break theme or the service worker)", () => {
		const html = fs.readFileSync(INDEX, "utf8");
		const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
		expect(scripts.length).toBeGreaterThan(0);
		for (const [, attributes, body] of scripts) {
			expect(attributes).toMatch(/\bsrc=/);
			expect(body?.trim()).toBe("");
		}
	});

	test("has no inline event-handler attributes or javascript: URLs", () => {
		const html = fs.readFileSync(INDEX, "utf8");
		expect(html).not.toMatch(/\son[a-z]+\s*=/i);
		expect(html).not.toMatch(/javascript:/i);
	});
});
