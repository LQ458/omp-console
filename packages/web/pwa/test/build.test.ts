import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BACKGROUND, renderIcon } from "../icons/design";
import { ICONS } from "../icons/generate";
import { readPngSize } from "../icons/png";
import { buildPwa } from "../../scripts/build-pwa";
import { FakeScope, ORIGIN } from "./fake-scope";

const WEB_ROOT = path.resolve(import.meta.dir, "../..");
const PUBLIC_DIR = path.join(WEB_ROOT, "public");

interface ManifestIcon {
	src: string;
	sizes: string;
	type: string;
	purpose?: string;
}
interface Manifest {
	name: string;
	id: string;
	short_name: string;
	display: string;
	start_url: string;
	scope: string;
	theme_color: string;
	background_color: string;
	icons: ManifestIcon[];
}

async function readManifest(dir: string): Promise<Manifest> {
	return Bun.file(path.join(dir, "manifest.webmanifest")).json();
}

describe("manifest", () => {
	it("advertises omp-console identity for an installable standalone app", async () => {
		const manifest = await readManifest(PUBLIC_DIR);
		expect(manifest).toMatchObject({
			id: "/",
			name: "omp console",
			short_name: "omp-console",
			display: "standalone",
			start_url: "/",
			scope: "/",
		});
		expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
		expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);
		expect(JSON.stringify(manifest).toLowerCase()).not.toContain("collab");
	});

	it("ships 192, 512 and maskable 512 icons whose files exist at exactly the declared pixel size", async () => {
		const { icons } = await readManifest(PUBLIC_DIR);
		const sizes = icons.map(icon => `${icon.sizes}/${icon.purpose}`).sort();
		expect(sizes).toEqual(["192x192/any", "512x512/any", "512x512/maskable"]);
		for (const icon of icons) {
			const { width, height } = readPngSize(await Bun.file(path.join(PUBLIC_DIR, icon.src)).bytes());
			expect(`${width}x${height}`).toBe(icon.sizes);
			expect(icon.type).toBe("image/png");
		}
	});

	it("provides a 180x180 apple-touch-icon and a favicon set at their declared sizes", async () => {
		const size = async (name: string) => readPngSize(await Bun.file(path.join(PUBLIC_DIR, name)).bytes());
		expect(await size("apple-touch-icon.png")).toEqual({ width: 180, height: 180 });
		expect(await size("favicon-32x32.png")).toEqual({ width: 32, height: 32 });
		expect(await size("favicon-16x16.png")).toEqual({ width: 16, height: 16 });
		expect(await size("favicon.png")).toEqual({ width: 256, height: 256 });
	});

	it("keeps the maskable mark inside the 80% safe-zone circle: everything outside it is plain background", () => {
		// Geometry is scale-independent, so a small render checks the same contract the 512px file is drawn from.
		const size = 96;
		const spec = { ...ICONS["icon-maskable-512.png"]!, size };
		const pixels = renderIcon(spec);
		let markPixels = 0;
		for (let y = 0; y < size; y++) {
			for (let x = 0; x < size; x++) {
				const offset = (y * size + x) * 4;
				const isBackground = BACKGROUND.every((channel, i) => pixels[offset + i] === channel) && pixels[offset + 3] === 255;
				const distance = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / size;
				if (distance > 0.4) expect(isBackground).toBe(true);
				else if (!isBackground) markPixels++;
			}
		}
		expect(markPixels).toBeGreaterThan(size * size * 0.1);
	});
});

describe("built app", () => {
	let dist: string;
	let precache: string[];
	let version: string;
	let buildVersion: string;

	beforeAll(async () => {
		dist = await fs.mkdtemp(path.join(os.tmpdir(), "omp-console-pwa-"));
		const built = await Bun.build({
			entrypoints: [path.join(WEB_ROOT, "index.html")],
			outdir: dist,
			minify: true,
			splitting: true,
			define: { "process.env.NODE_ENV": '"production"' },
			naming: { entry: "[hash].[ext]", chunk: "[hash].[ext]", asset: "[hash].[ext]" },
		});
		expect(built.success).toBe(true);
		for (const entry of await fs.readdir(dist)) {
			if (entry.endsWith(".html")) await fs.rename(path.join(dist, entry), path.join(dist, "index.html"));
		}
		const result = await buildPwa({ distDir: dist });
		precache = result.precache;
		version = result.version;
		buildVersion = result.buildVersion;
	});

	afterAll(() => fs.rm(dist, { recursive: true, force: true }));

	it("emits sw.js, a stable manifest and every icon, and every precache entry exists", async () => {
		for (const name of ["sw.js", "manifest.webmanifest", "index.html"]) {
			expect(await Bun.file(path.join(dist, name)).exists()).toBe(true);
		}
		for (const url of precache) {
			const file = url === "/" ? "index.html" : url.slice(1);
			expect(await Bun.file(path.join(dist, file)).exists()).toBe(true);
		}
		for (const icon of (await readManifest(dist)).icons) expect(precache).toContain(icon.src);
		expect(precache).toContain("/manifest.webmanifest");
		const hashedManifests = (await fs.readdir(dist)).filter(f => f.endsWith(".webmanifest") && f !== "manifest.webmanifest");
		expect(hashedManifests).toEqual([]);
	});
	it("embeds a build id for lazy-chunk recovery", async () => {
		const html = await Bun.file(path.join(dist, "index.html")).text();
		const embedded = /<meta name="omp-console-build-version" content="([a-f\d]{12})"/.exec(html)?.[1];

		expect(embedded).toBe(buildVersion);
	});

	it("pre-caches lazy JavaScript chunks and stylesheets for offline screens", async () => {
		const html = await Bun.file(path.join(dist, "index.html")).text();
		const assets = (await fs.readdir(dist)).filter(file => file !== "sw.js" && (file.endsWith(".js") || file.endsWith(".css")));
		const lazyScripts = assets.filter(file => file.endsWith(".js") && !html.includes(file));
		expect(lazyScripts.length).toBeGreaterThan(0);
		for (const asset of assets) expect(precache).toContain(`/${asset}`);
	});

	it("gives index.html the PWA head iOS and Chrome read", async () => {
		const html = await Bun.file(path.join(dist, "index.html")).text();
		expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
		expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
		expect(html).toContain("viewport-fit=cover");
		expect(html).toMatch(/<meta name="theme-color"[^>]*content="#/);
		// Registration lives in the bundle, not inline: the daemon's CSP (`script-src 'self'`) refuses inline scripts.
		expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
		const bundle = /<script[^>]*\bsrc="\.?\/?([^"]+)"/.exec(html)![1]!;
		expect(await Bun.file(path.join(dist, bundle)).text()).toContain('register("/sw.js"');
		const touch = /rel="apple-touch-icon"[^>]*href="\.?\/?([^"]+)"/.exec(html)![1]!;
		expect(readPngSize(await Bun.file(path.join(dist, touch)).bytes())).toEqual({ width: 180, height: 180 });
		// Head tags carry no collab branding.
		const headTags = (html.match(/<(?:meta|link|title)\b[^>]*>(?:[^<]*<\/title>)?/g) ?? []).join("\n");
		expect(headTags.toLowerCase()).not.toContain("collab");
	});

	it("builds a sw.js that, run against a scope, precaches exactly the emitted list under the emitted version", async () => {
		const code = await Bun.file(path.join(dist, "sw.js")).text();
		const scope = new FakeScope();
		scope.network = request => new Response(`net:${new URL(request.url).pathname}`);
		new Function("self", code)(scope);
		await scope.dispatch("install");
		expect(scope.caches.names()).toEqual([`omp-console-shell-${version}`]);
		const cached = [...scope.caches.stores.get(`omp-console-shell-${version}`)!.entries.keys()].sort();
		expect(cached).toEqual(precache.map(url => `${ORIGIN}${url}`).sort());
		// The relay stays untouched in the real artifact too.
		expect(scope.dispatchFetch(new Request(`${ORIGIN}/r/room`)).handled).toBe(false);
	});

	it("changes the cache version when any shipped file changes, so clients re-precache", async () => {
		const changedPublic = await fs.mkdtemp(path.join(os.tmpdir(), "omp-console-pwa-public-"));
		try {
			await fs.cp(PUBLIC_DIR, changedPublic, { recursive: true });
			const icon = path.join(changedPublic, "icon-192.png");
			await Bun.write(icon, Uint8Array.of(...(await Bun.file(icon).bytes()), 0));
			const rebuilt = await buildPwa({ distDir: dist, publicDir: changedPublic });
			expect(rebuilt.version).not.toBe(version);
		} finally {
			await fs.rm(changedPublic, { recursive: true, force: true });
		}
	});
});

