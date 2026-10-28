import { spawnSync } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type JsonRecord = Record<string, unknown>;
type PatchTarget = { name: string; forkPath: string };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspacePaths = ["packages/protocol", "packages/daemon", "packages/session-host", "packages/web"] as const;
const targets: PatchTarget[] = [
	{ name: "@oh-my-pi/pi-agent-core", forkPath: "packages/agent-core" },
	{ name: "@oh-my-pi/pi-ai", forkPath: "packages/ai" },
	{ name: "@oh-my-pi/pi-catalog", forkPath: "packages/catalog" },
	{ name: "@oh-my-pi/pi-coding-agent", forkPath: "packages/coding-agent" },
	{ name: "@oh-my-pi/pi-tui", forkPath: "packages/tui" },
	{ name: "@oh-my-pi/pi-wire", forkPath: "packages/wire" },
];

function record(value: unknown): JsonRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected an object in package metadata");
	return value as JsonRecord;
}

async function json(file: string): Promise<JsonRecord> {
	return record(JSON.parse(await readFile(file, "utf8")) as unknown);
}

async function exists(file: string): Promise<boolean> {
	try {
		await access(file);
		return true;
	} catch {
		return false;
	}
}

function run(binary: string, args: string[], cwd = root): string {
	const result = spawnSync(binary, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		const output = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim();
		throw new Error(`${binary} ${args.join(" ")} failed${output ? `:\n${output}` : ""}`);
	}
	return result.stdout ?? "";
}

async function installedPackage(from: string, name: string): Promise<string | undefined> {
	let directory = from;
	for (;;) {
		const candidate = path.join(directory, "node_modules", ...name.split("/"));
		if (await exists(path.join(candidate, "package.json"))) return realpath(candidate);
		const parent = path.dirname(directory);
		if (parent === directory) return undefined;
		directory = parent;
	}
}

async function packageRootFromWorkspaces(name: string): Promise<string> {
	for (const workspacePath of workspacePaths) {
		const candidate = await installedPackage(path.join(root, workspacePath), name);
		if (candidate) {
			const manifest = await json(path.join(candidate, "package.json"));
			if (manifest.name === name) return candidate;
		}
	}
	throw new Error(`Published ${name} is not installed; run bun install --frozen-lockfile first`);
}

async function copyPackageFiles(source: string, destination: string): Promise<void> {
	await mkdir(destination, { recursive: true });
	for (const directory of ["src", "dist/types"]) {
		const from = path.join(source, directory);
		if (!(await exists(from)) || !(await stat(from)).isDirectory()) {
			throw new Error(`${path.relative(root, source)} is missing ${directory}; build the fork package declarations before regenerating patches`);
		}
		await cp(from, path.join(destination, directory), { recursive: true });
	}
}

function patchFilename(name: string, version: string): string {
	return `${name.replace("/", "%2F")}@${version}.patch`;
}

async function generatePatch(target: PatchTarget, forkRoot: string, version: string, temporaryRoot: string, patchedDependencies: JsonRecord): Promise<{ file: string; content: string }> {
	const publishedRoot = await packageRootFromWorkspaces(target.name);
	const publishedManifest = await json(path.join(publishedRoot, "package.json"));
	if (publishedManifest.version !== version) throw new Error(`Installed ${target.name}@${String(publishedManifest.version)} does not match requested ${version}`);
	const forkPackage = path.join(forkRoot, target.forkPath);
	const forkManifest = await json(path.join(forkPackage, "package.json"));
	if (forkManifest.name !== target.name || forkManifest.version !== version) {
		throw new Error(`${target.forkPath} must be ${target.name}@${version}; found ${String(forkManifest.name)}@${String(forkManifest.version)}`);
	}

	const base = path.join(temporaryRoot, "published", target.name.replaceAll("/", "_").replaceAll("@", ""));
	const fork = path.join(temporaryRoot, "fork", target.name.replaceAll("/", "_").replaceAll("@", ""));
	await copyPackageFiles(publishedRoot, base);
	await copyPackageFiles(forkPackage, fork);

	const patchKey = `${target.name}@${version}`;
	const configuredPatch = patchedDependencies[patchKey];
	if (typeof configuredPatch === "string") {
		const existingPatch = path.join(root, configuredPatch);
		if (!(await exists(existingPatch))) throw new Error(`Configured patch is missing: ${configuredPatch}`);
		run("git", ["-C", base, "apply", "--reverse", "--check", existingPatch]);
		run("git", ["-C", base, "apply", "--reverse", existingPatch]);
	}

	const publishedRelative = path.relative(temporaryRoot, base).split(path.sep).join("/");
	const forkRelative = path.relative(temporaryRoot, fork).split(path.sep).join("/");
	const result = spawnSync("git", ["diff", "--no-index", "--no-color", "--binary", "--src-prefix=a/", "--dst-prefix=b/", publishedRelative, forkRelative], {
		cwd: temporaryRoot,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	if (result.error) throw result.error;
	if (result.status !== 1) {
		const output = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim();
		if (result.status === 0) throw new Error(`${target.name} has no changes; remove its patchedDependencies entry instead of writing an empty patch`);
		throw new Error(`Could not diff ${target.name}${output ? `:\n${output}` : ""}`);
	}
	const content = (result.stdout ?? "").split("\n").map(line => {
		if (line.startsWith("diff --git ")) return line.replace(`a/${publishedRelative}/`, "a/").replace(`b/${forkRelative}/`, "b/");
		if (line.startsWith("--- a/")) return line.replace(`a/${publishedRelative}/`, "a/");
		if (line.startsWith("+++ b/")) return line.replace(`b/${forkRelative}/`, "b/");
		return line;
	}).join("\n");
	if (!content.startsWith("diff --git a/")) throw new Error(`Generated patch paths for ${target.name} were not normalized`);
	return { file: patchFilename(target.name, version), content };
}

const args = process.argv.slice(2);
if (args.length !== 2 || !args[0] || !args[1]) {
	throw new Error("Usage: bun scripts/regen-patches.ts <omp-fork-checkout> <pinned-version>");
}
const forkRoot = await realpath(path.resolve(args[0]));
const version = args[1];
const rootPackage = await json(path.join(root, "package.json"));
const workspaces = record(rootPackage.workspaces);
const catalog = record(workspaces.catalog);
for (const target of targets) {
	if (catalog[target.name] !== version) throw new Error(`${target.name} is pinned to ${String(catalog[target.name])}, not ${version}`);
}
const forkTop = run("git", ["-C", forkRoot, "rev-parse", "--show-toplevel"]).trim();
if (await realpath(forkTop) !== forkRoot) throw new Error("The omp fork path must be the root of a Git checkout");
const patchedDependencies = record(rootPackage.patchedDependencies);
const temporaryRoot = await mkdtemp(path.join(root, ".regen-patches-"));
try {
	const generated: { file: string; content: string }[] = [];
	for (const target of targets) generated.push(await generatePatch(target, forkRoot, version, temporaryRoot, patchedDependencies));
	const staged = path.join(temporaryRoot, "staged");
	await mkdir(staged);
	for (const patch of generated) await writeFile(path.join(staged, patch.file), patch.content);
	const patchDirectory = path.join(root, "patches");
	for (const patch of generated) await rename(path.join(staged, patch.file), path.join(patchDirectory, patch.file));
	console.log(`Wrote ${generated.length} patches for omp ${version}`);
} finally {
	await rm(temporaryRoot, { recursive: true, force: true });
}
