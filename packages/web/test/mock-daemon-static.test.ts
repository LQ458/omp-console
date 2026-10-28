import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type MockDaemon, startMockDaemon } from "../dev/mock-daemon";

describe("mock daemon static assets", () => {
	let daemon: MockDaemon | undefined;
	let dist: string | undefined;

	afterEach(async () => {
		await daemon?.stop();
		daemon = undefined;
		if (dist !== undefined) await fs.rm(dist, { recursive: true, force: true });
		dist = undefined;
	});

	it("serves fallback HTML and built module/style assets with browser-loadable MIME types", async () => {
		dist = await fs.mkdtemp(path.join(os.tmpdir(), "deck-web-static-"));
		await Promise.all([
			Bun.write(path.join(dist, "index.html"), "<!doctype html><main>deck smoke</main>"),
			Bun.write(path.join(dist, "app.js"), "export const ready = true;"),
			Bun.write(path.join(dist, "app.css"), "main { display: block; }"),
		]);
		daemon = await startMockDaemon({ port: 0, seed: false, dist });

		const [html, script, stylesheet] = await Promise.all([
			fetch(`${daemon.url}/settings/overnight`),
			fetch(`${daemon.url}/app.js`),
			fetch(`${daemon.url}/app.css`),
		]);
		expect(html.headers.get("content-type")).toBe("text/html;charset=utf-8");
		expect(await html.text()).toContain("deck smoke");
		expect(script.headers.get("content-type")).toBe("text/javascript;charset=utf-8");
		expect(await script.text()).toBe("export const ready = true;");
		expect(stylesheet.headers.get("content-type")).toBe("text/css;charset=utf-8");
		expect(await stylesheet.text()).toBe("main { display: block; }");
	});
});
