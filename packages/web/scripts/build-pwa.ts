/**
 * Runs after `bun build ./index.html` (package script `postbuild`). Turns `dist/` into the PWA:
 *
 * - `manifest.webmanifest` and the icons it lists are copied from `public/` to stable, unhashed paths
 *   and `index.html` is pointed at `/manifest.webmanifest` (the bundler would otherwise hash it and
 *   leave a stale copy behind);
 * - the precache list is every local asset `index.html` references, every built JS/CSS chunk, plus `/`, the manifest and its icons;
 * - `sw.js` is bundled from `pwa/sw.ts` with that list and a content-hash version baked in, so any change
 *   to a shipped file gives a new cache name;
 * - `precache-manifest.json` records the same list for inspection.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SwConfig } from "../pwa/sw-core";

const WEB_ROOT = path.resolve(import.meta.dir, "..");
const MANIFEST_NAME = "manifest.webmanifest";
const MANIFEST_LINK = /<link\s+rel="manifest"\s+href="[^"]*"\s*\/?>/;
const BUILD_VERSION_META = /<meta\s+name="omp-console-build-version"\s+content="[^"]*"\s*\/?>/;

export interface BuildPwaOptions {
	distDir?: string;
	publicDir?: string;
	swEntry?: string;
}

export interface BuildPwaResult extends SwConfig {
	files: string[];
	buildVersion: string;
}

interface ManifestIcon {
	src: string;
}

function localUrl(raw: string): string | null {
	if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//") || raw.startsWith("#")) return null;
	const clean = raw.split(/[?#]/)[0]!;
	if (!clean) return null;
	return clean.startsWith("/") ? clean : `/${clean.replace(/^\.\//, "")}`;
}

export async function buildPwa(options: BuildPwaOptions = {}): Promise<BuildPwaResult> {
	const distDir = options.distDir ?? path.join(WEB_ROOT, "dist");
	const publicDir = options.publicDir ?? path.join(WEB_ROOT, "public");
	const swEntry = options.swEntry ?? path.join(WEB_ROOT, "pwa/sw.ts");

	const indexPath = path.join(distDir, "index.html");
	let html: string;
	try {
		html = await Bun.file(indexPath).text();
	} catch {
		throw new Error(`${indexPath} not found: run the web build first`);
	}

	const manifest = (await Bun.file(path.join(publicDir, MANIFEST_NAME)).json()) as { icons?: ManifestIcon[] };
	const iconPaths = (manifest.icons ?? []).map(icon => localUrl(icon.src)).filter((src): src is string => src !== null);
	for (const icon of iconPaths) {
		const source = Bun.file(path.join(publicDir, icon));
		if (!(await source.exists())) throw new Error(`manifest icon ${icon} is missing from public/`);
		await Bun.write(path.join(distDir, icon), source);
	}
	await Bun.write(path.join(distDir, MANIFEST_NAME), Bun.file(path.join(publicDir, MANIFEST_NAME)));

	// Drop the bundler's hashed copy of the manifest, then point the page at the stable one.
	const hashed = MANIFEST_LINK.exec(html)?.[0].match(/href="([^"]*)"/)?.[1];
	if (!hashed) throw new Error("index.html has no <link rel=\"manifest\">");
	const hashedFile = localUrl(hashed);
	if (hashedFile && hashedFile !== `/${MANIFEST_NAME}`) await fs.rm(path.join(distDir, hashedFile), { force: true });
	html = html.replace(MANIFEST_LINK, `<link rel="manifest" href="/${MANIFEST_NAME}" />`);
	await Bun.write(indexPath, html);

	const referenced = new Set<string>();
	for (const match of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
		const url = localUrl(match[1]!);
		if (url) referenced.add(url);
	}
	referenced.add(`/${MANIFEST_NAME}`);
	for (const icon of iconPaths) referenced.add(icon);
	for (const asset of await fs.readdir(distDir)) {
		if (asset !== "sw.js" && (asset.endsWith(".js") || asset.endsWith(".css"))) referenced.add(`/${asset}`);
	}
	referenced.delete("/sw.js");
	const files = [...referenced].sort();
	const precache = ["/", ...files];
	if (!BUILD_VERSION_META.test(html)) throw new Error('index.html has no "omp-console-build-version" meta tag');
	const stableHtml = html.replace(BUILD_VERSION_META, '<meta name="omp-console-build-version" content="BUILD_VERSION" />');
	const buildHasher = new Bun.CryptoHasher("sha256");
	for (const url of precache) {
		const file = url === "/" ? indexPath : path.join(distDir, url);
		const bytes = url === "/" ? new TextEncoder().encode(stableHtml) : await Bun.file(file).bytes();
		buildHasher.update(url);
		buildHasher.update("\0");
		buildHasher.update(bytes);
		buildHasher.update("\0");
	}
	const buildVersion = buildHasher.digest("hex").slice(0, 12);
	html = html.replace(BUILD_VERSION_META, `<meta name="omp-console-build-version" content="${buildVersion}" />`);
	await Bun.write(indexPath, html);
	const hasher = new Bun.CryptoHasher("sha256");
	for (const url of precache) {
		const file = url === "/" ? indexPath : path.join(distDir, url);
		const bytes = await Bun.file(file).bytes().catch(() => {
			throw new Error(`precache entry ${url} is not in ${distDir}`);
		});
		hasher.update(url);
		hasher.update("\0");
		hasher.update(bytes);
		hasher.update("\0");
	}
	const version = hasher.digest("hex").slice(0, 12);

	const config: SwConfig = { version, precache };

	const built = await Bun.build({
		entrypoints: [swEntry],
		outdir: distDir,
		naming: "sw.js",
		target: "browser",
		minify: true,
		define: { __OMP_CONSOLE_SW_CONFIG__: JSON.stringify(config) },
	});
	if (!built.success) throw new Error(`sw.js build failed:\n${built.logs.map(log => log.message).join("\n")}`);

	await Bun.write(path.join(distDir, "precache-manifest.json"), `${JSON.stringify(config, null, 2)}\n`);
	return { ...config, files, buildVersion };
}

if (import.meta.main) {
	// The build script's `bun build` runs whichever `bun` is first on PATH. Bun 1.2 writes an index.html that
	// points at a shared chunk instead of the app entry (blank page), so refuse anything older than 1.4, the
	// installer's minimum. Newer releases (the Bun installer ships 1.4.4 today) must keep working.
	const [major = 0, minor = 0] = Bun.version.split(".").map(Number);
	if (major < 1 || (major === 1 && minor < 4)) {
		throw new Error(`web build ran on Bun ${Bun.version}; Bun 1.4 or newer is required (\`bun upgrade\`)`);
	}
	const result = await buildPwa();
	console.log(`pwa: sw.js version ${result.version}, ${result.precache.length} precache entries`);
}
