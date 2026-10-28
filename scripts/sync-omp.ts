import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type JsonRecord = Record<string, unknown>;
type FileStatus = "clean" | "absorbed" | "resolved" | "conflict(unresolved)";
type FileReport = {
	file: string;
	status: FileStatus;
	reason?: string;
	conflictText?: string;
	baseBytes: number;
	oursBytes: number;
	theirsBytes: number;
};
type PatchStats = { bytes: number; addedLines: number; removedLines: number; netLines: number };
type PackageReport = {
	name: string;
	fromVersion: string;
	toVersion: string;
	fromIntegrity: string;
	toIntegrity: string;
	patchBefore: PatchStats;
	patchAfter: PatchStats;
	files: FileReport[];
};
type Report = {
	fromVersion: string;
	toVersion: string;
	registry: string;
	packages: PackageReport[];
	unresolvedConflicts: { package: string; file: string }[];
};
type PackageMetadata = {
	"dist-tags"?: Record<string, unknown>;
	versions?: Record<string, unknown>;
	name?: unknown;
	version?: unknown;
	dist?: unknown;
};
type Tarball = { integrity: string; url: string };
type SyncOptions = { version: string; registry?: string; from?: string; report?: string };
type PatchTarget = { name: string; oldVersion: string; patchPath: string };
type PackageMerge = { report: PackageReport; patchFile: string; patchContent: string };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const patchedRoots = ["src", "dist/types"] as const;
const registryName = "@oh-my-pi/pi-coding-agent";
const generatedJson = new Set(["models.json", "compat/rules.json"]);
const MAX_BUFFER = 256 * 1024 * 1024;

function asRecord(value: unknown, label: string): JsonRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as JsonRecord;
}

async function readJson(file: string): Promise<JsonRecord> {
	return asRecord(JSON.parse(await readFile(file, "utf8")) as unknown, path.relative(root, file));
}

async function exists(file: string): Promise<boolean> {
	try {
		await access(file);
		return true;
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
}

function run(binary: string, args: string[], cwd: string, allowedStatuses: readonly number[] = [0]): { status: number; stdout: string; stderr: string } {
	const result = spawnSync(binary, args, { cwd, encoding: "utf8", maxBuffer: MAX_BUFFER });
	if (result.error) throw result.error;
	const status = result.status ?? -1;
	const stdout = result.stdout ?? "";
	const stderr = result.stderr ?? "";
	if (!allowedStatuses.includes(status)) {
		const output = `${stderr}${stdout}`.trim();
		throw new Error(`${binary} ${args.join(" ")} failed${output ? `:\n${output}` : ` (exit ${status})`}`);
	}
	return { status, stdout, stderr };
}

function patchStats(content: string): PatchStats {
	let addedLines = 0;
	let removedLines = 0;
	for (const line of content.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) addedLines++;
		else if (line.startsWith("-") && !line.startsWith("---")) removedLines++;
	}
	return { bytes: Buffer.byteLength(content), addedLines, removedLines, netLines: addedLines - removedLines };
}

function patchFilename(name: string, version: string): string {
	return `${name.replaceAll("/", "%2F")}@${version}.patch`;
}

function parseOptions(args: string[]): SyncOptions {
	const version = args.shift();
	if (!version || version.startsWith("--")) throw new Error("Usage: bun scripts/sync-omp.ts <version|latest> [--registry <url>] [--from <oldVersion>] [--report <file>]");
	const options: SyncOptions = { version };
	while (args.length > 0) {
		const flag = args.shift();
		const value = args.shift();
		if (!value) throw new Error(`Missing value for ${flag}`);
		if (flag === "--registry") options.registry = value;
		else if (flag === "--from") options.from = value;
		else if (flag === "--report") options.report = value;
		else throw new Error(`Unknown option: ${flag}`);
	}
	return options;
}

function packageEntry(key: string, patchPath: unknown): PatchTarget {
	const separator = key.lastIndexOf("@");
	if (separator <= 0 || typeof patchPath !== "string") throw new Error(`Invalid patchedDependencies entry: ${key}`);
	return { name: key.slice(0, separator), oldVersion: key.slice(separator + 1), patchPath };
}

function assertInsideRoot(file: string, label: string): string {
	const resolved = path.resolve(root, file);
	if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error(`${label} must be inside the worktree`);
	return resolved;
}

function registryFromLock(lockText: string): string {
	const tarball = lockText.match(/https?:\/\/[^"\s]+?\.tgz/);
	if (!tarball) throw new Error("Could not find a tarball registry URL in bun.lock; pass --registry");
	return new URL(tarball[0]).origin;
}

function packageUrl(registry: string, name: string, version?: string): URL {
	const encodedName = name.replace("/", "%2f");
	const suffix = version === undefined ? encodedName : `${encodedName}/${encodeURIComponent(version)}`;
	return new URL(suffix, `${registry.replace(/\/+$/, "")}/`);
}

async function jsonFetch(url: URL): Promise<PackageMetadata> {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`Registry request ${url} failed: HTTP ${response.status}`);
	return asRecord(await response.json() as unknown, `registry response for ${url}`) as PackageMetadata;
}

async function resolveVersion(registry: string, requested: string): Promise<string> {
	if (requested !== "latest") return requested;
	const metadata = await jsonFetch(packageUrl(registry, registryName));
	const version = metadata["dist-tags"]?.latest;
	if (typeof version !== "string" || version.length === 0) throw new Error(`${registryName} has no latest dist-tag at ${registry}`);
	return version;
}

async function resolveTarball(registry: string, name: string, version: string): Promise<Tarball> {
	const metadata = await jsonFetch(packageUrl(registry, name, version));
	if (metadata.name !== name || metadata.version !== version) {
		throw new Error(`Registry returned ${String(metadata.name)}@${String(metadata.version)} for ${name}@${version}`);
	}
	const dist = asRecord(metadata.dist, `dist metadata for ${name}@${version}`);
	const url = dist.tarball;
	const integrity = dist.integrity;
	if (typeof url !== "string" || typeof integrity !== "string" || !integrity.startsWith("sha512-")) {
		throw new Error(`Registry response for ${name}@${version} has no SHA-512 tarball integrity`);
	}
	return { integrity, url };
}

function verifyIntegrity(bytes: Uint8Array, integrity: string, label: string): void {
	const expected = integrity.slice("sha512-".length);
	const actual = createHash("sha512").update(bytes).digest("base64");
	if (actual !== expected) throw new Error(`SHA-512 integrity mismatch for ${label}`);
}

async function downloadTarball(tarball: Tarball, cache: Map<string, string>, cacheRoot: string): Promise<string> {
	const cached = cache.get(tarball.integrity);
	if (cached) return cached;
	const response = await fetch(tarball.url);
	if (!response.ok) throw new Error(`Tarball request ${tarball.url} failed: HTTP ${response.status}`);
	const bytes = new Uint8Array(await response.arrayBuffer());
	verifyIntegrity(bytes, tarball.integrity, tarball.url);
	const filename = `${createHash("sha256").update(tarball.integrity).digest("hex")}.tgz`;
	const file = path.join(cacheRoot, filename);
	await writeFile(file, bytes);
	cache.set(tarball.integrity, file);
	return file;
}

async function extractTarball(archive: string, destination: string): Promise<void> {
	const listing = run("tar", ["-tzf", archive], root).stdout.split("\n").filter(Boolean);
	for (const entry of listing) {
		const normalized = entry.replaceAll("\\", "/");
		if (normalized.startsWith("/") || normalized.split("/").some(part => part === "..") || !(normalized === "package" || normalized.startsWith("package/"))) {
			throw new Error(`Unsafe path in npm tarball: ${entry}`);
		}
	}
	await mkdir(destination, { recursive: true });
	run("tar", ["--no-same-owner", "-xzf", archive, "-C", destination, "--strip-components=1"], root);
	for (const directory of patchedRoots) {
		if (!(await exists(path.join(destination, directory)))) throw new Error(`Published package is missing ${directory}: ${path.basename(archive)}`);
	}
}

async function listFiles(directory: string, prefix = ""): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
		const absolute = path.join(directory, entry.name);
		if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink in package source: ${absolute}`);
		if (entry.isDirectory()) files.push(...await listFiles(absolute, relative));
		else if (entry.isFile()) files.push(relative);
	}
	return files;
}

async function packageFiles(directory: string): Promise<Map<string, Buffer>> {
	const files = new Map<string, Buffer>();
	for (const patchedRoot of patchedRoots) {
		const absolute = path.join(directory, patchedRoot);
		for (const relative of await listFiles(absolute, patchedRoot)) files.set(relative, await readFile(path.join(directory, relative)));
	}
	return files;
}

async function writeMergedFile(directory: string, relative: string, content: Buffer | undefined): Promise<void> {
	const destination = path.join(directory, relative);
	if (content === undefined) {
		await rm(destination, { force: true });
		return;
	}
	await mkdir(path.dirname(destination), { recursive: true });
	await writeFile(destination, content);
}

async function mergeText(workDirectory: string, relative: string, base: Buffer | undefined, ours: Buffer | undefined, theirs: Buffer | undefined): Promise<{ content: Buffer; conflict: boolean }> {
	const temporary = path.join(workDirectory, "merge");
	const baseFile = path.join(temporary, "base");
	const oursFile = path.join(temporary, "ours");
	const theirsFile = path.join(temporary, "theirs");
	await mkdir(temporary, { recursive: true });
	await Promise.all([
		writeFile(baseFile, base ?? Buffer.alloc(0)),
		writeFile(oursFile, ours ?? Buffer.alloc(0)),
		writeFile(theirsFile, theirs ?? Buffer.alloc(0)),
	]);
	const result = spawnSync("git", ["merge-file", "--diff3", "-p", oursFile, baseFile, theirsFile], { cwd: workDirectory, maxBuffer: MAX_BUFFER });
	if (result.error) throw result.error;
	const status = result.status ?? -1;
	const content = result.stdout ?? Buffer.alloc(0);
	const conflict = content.includes("<<<<<<< ") && content.includes(">>>>>>> ");
	if (status !== 0 && !conflict) throw new Error(`git merge-file failed for ${relative} (exit ${status}): ${String(result.stderr ?? "")}${String(content)}`);
	return { content, conflict };
}

function resolutionPath(version: string, packageName: string, file: string): string {
	return path.join(root, "patches", "resolutions", version, packageName, file);
}

type ResolutionSpec = { choices: ("ours" | "theirs")[]; patch?: string };

function parseResolutionSpec(content: string): ResolutionSpec | undefined {
	const lines = content.split("\n");
	if (lines[0] !== "# omp-sync-resolution v1") return undefined;
	const patchIndex = lines.indexOf("--- patch ---");
	const choiceLines = lines.slice(1, patchIndex < 0 ? lines.length : patchIndex).filter(line => line.trim() !== "" && !line.startsWith("#"));
	const choices: ResolutionSpec["choices"] = [];
	for (const line of choiceLines) {
		if (line !== "ours" && line !== "theirs") throw new Error("Resolution choices must be `ours` or `theirs`");
		choices.push(line);
	}
	const patch = patchIndex < 0 ? undefined : lines.slice(patchIndex + 1).join("\n");
	return { choices, ...(patch ? { patch } : {}) };
}

function resolveConflictHunks(merged: Buffer, choices: readonly ("ours" | "theirs")[], file: string): Buffer {
	const lines = merged.toString("utf8").split("\n");
	const resolved: string[] = [];
	let choiceIndex = 0;
	for (let index = 0; index < lines.length; index++) {
		if (!lines[index]!.startsWith("<<<<<<< ")) {
			resolved.push(lines[index]!);
			continue;
		}
		const baseMarker = lines.findIndex((line, position) => position > index && line.startsWith("||||||| "));
		const separator = lines.findIndex((line, position) => position > baseMarker && line === "=======");
		const endMarker = lines.findIndex((line, position) => position > separator && line.startsWith(">>>>>>> "));
		const choice = choices[choiceIndex];
		if (baseMarker < 0 || separator < 0 || endMarker < 0 || choice === undefined) {
			throw new Error(`Resolution for ${file} does not match its conflict hunks`);
		}
		resolved.push(...lines.slice(choice === "ours" ? index + 1 : separator + 1, choice === "ours" ? baseMarker : endMarker));
		choiceIndex++;
		index = endMarker;
	}
	if (choiceIndex !== choices.length) throw new Error(`Resolution for ${file} has ${choices.length} choices for ${choiceIndex} conflict hunks`);
	return Buffer.from(resolved.join("\n"));
}

async function mergePackage(
	target: PatchTarget,
	newVersion: string,
	registry: string,
	temporaryRoot: string,
	cache: Map<string, string>,
	cacheRoot: string,
	usedResolutions: Set<string>,
): Promise<PackageMerge> {
	const oldTarball = await resolveTarball(registry, target.name, target.oldVersion);
	const newTarball = await resolveTarball(registry, target.name, newVersion);
	const packageKey = `${target.name}@${target.oldVersion}`;
	const configuredPatch = assertInsideRoot(target.patchPath, `patch path for ${packageKey}`);
	if (!(await exists(configuredPatch))) throw new Error(`Configured patch is missing: ${target.patchPath}`);

	const folder = path.join(temporaryRoot, target.name.replaceAll("/", "_"));
	const oldRoot = path.join(folder, "base");
	const oursRoot = path.join(folder, "ours");
	const newRoot = path.join(folder, "theirs");
	const mergedRoot = path.join(folder, "merged");
	await mkdir(folder, { recursive: true });
	await extractTarball(await downloadTarball(oldTarball, cache, cacheRoot), oldRoot);
	await cp(oldRoot, oursRoot, { recursive: true });
	const applyDirectory = path.relative(root, oursRoot).split(path.sep).join("/");
	run("git", ["apply", `--directory=${applyDirectory}`, "--check", configuredPatch], root);
	run("git", ["apply", `--directory=${applyDirectory}`, configuredPatch], root);
	await extractTarball(await downloadTarball(newTarball, cache, cacheRoot), newRoot);
	await cp(newRoot, mergedRoot, { recursive: true });

	const baseFiles = await packageFiles(oldRoot);
	const oursFiles = await packageFiles(oursRoot);
	const theirsFiles = await packageFiles(newRoot);
	const changed = new Set([...baseFiles.keys(), ...oursFiles.keys()]);
	const patchChangedFiles = [...changed].filter(file => {
		const base = baseFiles.get(file);
		const ours = oursFiles.get(file);
		return base === undefined ? ours !== undefined : ours === undefined || !base.equals(ours);
	});
	if (patchChangedFiles.length === 0 && (await readFile(configuredPatch)).byteLength > 0) {
		const diff = run("git", ["diff", "--no-index", "--stat", oldRoot, oursRoot], folder, [0, 1]);
		throw new Error(`Applying ${target.patchPath} to published ${target.name}@${target.oldVersion} changed no src/ or dist/types files (${baseFiles.size} base, ${oursFiles.size} patched; git diff exit ${diff.status}: ${diff.stdout.trim()}); refusing to drop the patch`);
	}
	const files: FileReport[] = [];
	let unresolved = false;
	for (const file of [...changed].sort()) {
		const base = baseFiles.get(file);
		const ours = oursFiles.get(file);
		const theirs = theirsFiles.get(file);
		if (base?.equals(ours ?? Buffer.alloc(0)) === true || (base === undefined && ours === undefined)) continue;
		if (generatedJson.has(file) || file.endsWith("/models.json") || file.endsWith("/compat/rules.json")) {
			files.push({ file, status: "absorbed", reason: "generated JSON takes upstream", baseBytes: base?.byteLength ?? 0, oursBytes: ours?.byteLength ?? 0, theirsBytes: theirs?.byteLength ?? 0 });
			continue;
		}
		let result: Buffer | undefined;
		let status: FileStatus;
		let conflictText: string | undefined;
		// A full-content resolution (no `# omp-sync-resolution v1` header) is the reviewed final file: it applies whatever
		// the merge would do, so line-level drops in cleanly merged files are recorded and reproducible too. It is bound to
		// the patched old file it was reviewed against (`<file>.ours.sha256`): a later edit to the source patch must be
		// re-reviewed instead of being silently replaced.
		const overridePath = resolutionPath(newVersion, target.name, file);
		// Resolutions describe the move from the old release to this one; re-syncing the same version keeps the patch as is.
		const override = target.oldVersion !== newVersion && await exists(overridePath) ? await readFile(overridePath) : undefined;
		if (override !== undefined) usedResolutions.add(overridePath);
		if (override !== undefined && parseResolutionSpec(override.toString("utf8")) === undefined) {
			const reviewed = await exists(`${overridePath}.ours.sha256`) ? (await readFile(`${overridePath}.ours.sha256`, "utf8")).trim() : undefined;
			const actual = ours === undefined ? "absent" : createHash("sha256").update(ours).digest("hex");
			if (reviewed !== actual) {
				throw new Error(`Full-content resolution for ${target.name} ${file} was reviewed against a different patched file (expected ${reviewed ?? "a .ours.sha256 file"}, found ${actual}); review it and update ${path.relative(root, overridePath)}.ours.sha256`);
			}
			usedResolutions.add(`${overridePath}.ours.sha256`);
			result = override;
			status = "resolved";
		} else if (ours?.equals(theirs ?? Buffer.alloc(0)) === true && (ours !== undefined || theirs === undefined)) {
			result = theirs;
			status = "absorbed";
		} else if (ours !== undefined && base?.equals(theirs ?? Buffer.alloc(0)) === true) {
			result = ours;
			status = "clean";
		} else {
			const merged = await mergeText(folder, file, base, ours, theirs);
			if (!merged.conflict) {
				result = merged.content.length === 0 && ours === undefined ? undefined : merged.content;
				status = result?.equals(theirs ?? Buffer.alloc(0)) === true ? "absorbed" : "clean";
			} else {
				const resolution = resolutionPath(newVersion, target.name, file);
				if (await exists(resolution)) {
					const resolutionContent = await readFile(resolution);
					const spec = parseResolutionSpec(resolutionContent.toString("utf8"));
					if (spec === undefined) {
						result = resolutionContent;
					} else {
						result = resolveConflictHunks(merged.content, spec.choices, file);
						await writeMergedFile(mergedRoot, file, result);
						if (spec.patch) {
							const patchLines = spec.patch.split("\n");
							const headers = patchLines.filter(line => line.startsWith("diff --git "));
							if (
								headers.length !== 1 ||
								headers[0] !== `diff --git a/${file} b/${file}` ||
								!patchLines.includes(`--- a/${file}`) ||
								!patchLines.includes(`+++ b/${file}`)
							) {
								throw new Error(`Resolution patch for ${file} must change only that file`);
							}
							const resolutionPatch = path.join(folder, "resolution.patch");
							await writeFile(resolutionPatch, spec.patch);
							const applyDirectory = path.relative(root, mergedRoot).split(path.sep).join("/");
							run("git", ["apply", `--directory=${applyDirectory}`, "--check", resolutionPatch], root);
							run("git", ["apply", `--directory=${applyDirectory}`, resolutionPatch], root);
							const resolvedFile = path.join(mergedRoot, file);
							result = await exists(resolvedFile) ? await readFile(resolvedFile) : undefined;
						}
					}
					status = "resolved";
				} else {
					conflictText = merged.content.toString("utf8");
					status = "conflict(unresolved)";
					unresolved = true;
				}
			}
		}
		if (status !== "conflict(unresolved)") await writeMergedFile(mergedRoot, file, result);
		files.push({ file, status, ...(conflictText === undefined ? {} : { conflictText }), baseBytes: base?.byteLength ?? 0, oursBytes: ours?.byteLength ?? 0, theirsBytes: theirs?.byteLength ?? 0 });
	}

	const beforePatch = await readFile(configuredPatch, "utf8");
	const diff = run("git", ["diff", "--no-index", "--no-color", "--binary", "--src-prefix=a/", "--dst-prefix=b/", path.relative(temporaryRoot, newRoot), path.relative(temporaryRoot, mergedRoot)], temporaryRoot, [0, 1]);
	let patchContent = diff.status === 0 ? "" : diff.stdout.split("\n").map(line => {
		if (line.startsWith("diff --git ")) return line.replace(`a/${path.relative(temporaryRoot, newRoot)}/`, "a/").replace(`b/${path.relative(temporaryRoot, mergedRoot)}/`, "b/");
		if (line.startsWith("--- a/")) return line.replace(`a/${path.relative(temporaryRoot, newRoot)}/`, "a/");
		if (line.startsWith("+++ b/")) return line.replace(`b/${path.relative(temporaryRoot, mergedRoot)}/`, "b/");
		return line;
	}).join("\n");
	if (patchContent && !patchContent.startsWith("diff --git a/")) throw new Error(`Generated patch paths for ${target.name} were not normalized`);
	if (unresolved) patchContent = "";
	const report: PackageReport = {
		name: target.name,
		fromVersion: target.oldVersion,
		toVersion: newVersion,
		fromIntegrity: oldTarball.integrity,
		toIntegrity: newTarball.integrity,
		patchBefore: patchStats(beforePatch),
		patchAfter: patchStats(patchContent),
		files,
	};
	const newPatchFile = patchFilename(target.name, newVersion);
	return { report, patchFile: newPatchFile, patchContent };
}

function markdownReport(report: Report): string {
	const rows = [
		"# omp sync report",
		"",
		`- From: \`${report.fromVersion}\``,
		`- To: \`${report.toVersion}\``,
		`- Registry: \`${report.registry}\``,
		"",
		"| Package | Before bytes | After bytes | Before net lines | After net lines | Files |",
		"|---|---:|---:|---:|---:|---:|",
	];
	for (const pkg of report.packages) rows.push(`| ${pkg.name} | ${pkg.patchBefore.bytes} | ${pkg.patchAfter.bytes} | ${pkg.patchBefore.netLines} | ${pkg.patchAfter.netLines} | ${pkg.files.length} |`);
	rows.push("", "## File decisions", "", "| Package | File | Status | Reason |", "|---|---|---|---|");
	for (const pkg of report.packages) {
		for (const file of pkg.files) rows.push(`| ${pkg.name} | \`${file.file}\` | ${file.status} | ${file.reason ?? ""} |`);
	}
	if (report.unresolvedConflicts.length > 0) {
		rows.push("", "## Unresolved conflicts", "");
		for (const conflict of report.unresolvedConflicts) rows.push(`- \`${conflict.package}/${conflict.file}\``);
	}
	rows.push("");
	return rows.join("\n");
}

async function writeReport(reportPath: string, report: Report): Promise<void> {
	const markdownPath = assertInsideRoot(reportPath, "report path");
	const extension = path.extname(markdownPath);
	const jsonPath = extension ? `${markdownPath.slice(0, -extension.length)}.json` : `${markdownPath}.json`;
	await mkdir(path.dirname(markdownPath), { recursive: true });
	await writeFile(markdownPath, markdownReport(report));
	await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
}

function isConflict(report: Report): boolean {
	return report.unresolvedConflicts.length > 0;
}

async function main(options: SyncOptions): Promise<void> {
	const packageFile = path.join(root, "package.json");
	const lockFile = path.join(root, "bun.lock");
	const rootPackage = await readJson(packageFile);
	const workspaces = asRecord(rootPackage.workspaces, "workspaces");
	const catalog = asRecord(workspaces.catalog, "workspaces.catalog");
	const patchedDependencies = asRecord(rootPackage.patchedDependencies, "patchedDependencies");
	const catalogVersions = Object.entries(catalog).filter(([name, version]) => name.startsWith("@oh-my-pi/") && typeof version === "string").map(([, version]) => version as string);
	const distinctCatalogVersions = [...new Set(catalogVersions)];
	if (distinctCatalogVersions.length !== 1) throw new Error(`omp catalog entries must share one version; found ${distinctCatalogVersions.join(", ")}`);
	const fromVersion = options.from ?? distinctCatalogVersions[0];
	if (!fromVersion || fromVersion !== distinctCatalogVersions[0]) throw new Error(`--from ${String(fromVersion)} does not match the current catalog ${distinctCatalogVersions[0]}`);
	const targets = Object.entries(patchedDependencies).map(([key, patch]) => packageEntry(key, patch));
	if (targets.some(target => target.oldVersion !== fromVersion)) throw new Error(`Every patched package must be pinned to --from ${fromVersion}`);
	const lockText = await readFile(lockFile, "utf8");
	const registry = options.registry ? new URL(options.registry).origin : registryFromLock(lockText);
	const newVersion = await resolveVersion(registry, options.version);
	if (newVersion.length === 0 || /[\s/]/.test(newVersion)) throw new Error(`Invalid resolved omp version: ${newVersion}`);
	// Inside the repo because `git apply --directory` only accepts repo-relative paths; ignored by .gitignore and removed
	// on every exit, including Ctrl-C and SIGTERM.
	const temporaryRoot = await mkdtemp(path.join(root, ".omp-sync-"));
	const removeOnSignal = (signal: NodeJS.Signals): void => {
		rmSync(temporaryRoot, { recursive: true, force: true });
		process.exit(signal === "SIGINT" ? 130 : 143);
	};
	process.once("SIGINT", removeOnSignal);
	process.once("SIGTERM", removeOnSignal);
	const cacheRoot = path.join(temporaryRoot, "tarballs");
	await mkdir(cacheRoot);
	const cache = new Map<string, string>();
	const results: PackageMerge[] = [];
	const report: Report = { fromVersion, toVersion: newVersion, registry, packages: [], unresolvedConflicts: [] };
	const reportPath = options.report ?? ".omp-sync-report.md";
	try {
		const usedResolutions = new Set<string>();
		for (const target of targets) {
			const result = await mergePackage(target, newVersion, registry, temporaryRoot, cache, cacheRoot, usedResolutions);
			results.push(result);
			report.packages.push(result.report);
			for (const file of result.report.files) {
				if (file.status === "conflict(unresolved)") report.unresolvedConflicts.push({ package: target.name, file: file.file });
			}
		}
		// A resolution nothing consulted is stale (upstream absorbed the change, or the path moved): say so.
		const resolutionsRoot = path.join(root, "patches", "resolutions", newVersion);
		if (targets.some(target => target.oldVersion !== newVersion) && await exists(resolutionsRoot)) {
			for (const relative of await listFiles(resolutionsRoot)) {
				const file = path.join(resolutionsRoot, relative);
				if (!usedResolutions.has(file)) console.warn(`warning: unused omp sync resolution ${path.relative(root, file)}`);
			}
		}
		await writeReport(reportPath, report);
		if (isConflict(report)) throw new Error(`Unresolved omp sync conflicts; see ${reportPath} and ${path.extname(reportPath) ? reportPath.replace(/\.[^.]+$/, ".json") : `${reportPath}.json`}`);

		const nextPackage = structuredClone(rootPackage) as JsonRecord;
		const nextWorkspaces = asRecord(nextPackage.workspaces, "workspaces");
		const nextCatalog = asRecord(nextWorkspaces.catalog, "workspaces.catalog");
		for (const name of Object.keys(nextCatalog)) if (name.startsWith("@oh-my-pi/")) nextCatalog[name] = newVersion;
		const nextPatched: JsonRecord = {};
		for (const result of results) if (result.patchContent !== "") nextPatched[`${result.report.name}@${newVersion}`] = path.posix.join("patches", result.patchFile);
		nextPackage.patchedDependencies = nextPatched;
		const nextPackageText = `${JSON.stringify(nextPackage, null, "\t")}\n`;
		const currentPackageText = await readFile(packageFile, "utf8");
		const stage = path.join(temporaryRoot, "staged");
		await mkdir(stage);
		const newPatchPaths = new Set(results.filter(result => result.patchContent !== "").map(result => path.join(root, "patches", result.patchFile)));
		let changed = nextPackageText !== currentPackageText;
		for (const result of results) {
			if (result.patchContent === "") continue;
			const destination = path.join(root, "patches", result.patchFile);
			const contentExists = await exists(destination);
			const current = contentExists ? await readFile(destination, "utf8") : undefined;
			if (current !== result.patchContent) {
				changed = true;
				const staged = path.join(stage, result.patchFile);
				await mkdir(path.dirname(staged), { recursive: true });
				await writeFile(staged, result.patchContent);
			}
		}
		for (const target of targets) {
			const oldPatch = assertInsideRoot(target.patchPath, `patch path for ${target.name}`);
			if (!newPatchPaths.has(oldPatch)) changed = true;
		}
		if (!changed) {
			console.log(`omp ${newVersion}: no changes`);
			return;
		}
		for (const result of results) {
			if (result.patchContent === "") continue;
			const staged = path.join(stage, result.patchFile);
			if (await exists(staged)) await rename(staged, path.join(root, "patches", result.patchFile));
		}
		for (const target of targets) {
			const oldPatch = assertInsideRoot(target.patchPath, `patch path for ${target.name}`);
			if (!newPatchPaths.has(oldPatch)) await rm(oldPatch, { force: true });
		}
		const packageStage = path.join(stage, "package.json");
		await writeFile(packageStage, nextPackageText);
		await rename(packageStage, packageFile);
		const install = run(process.execPath, ["install"], root, [0]);
		console.log(install.stdout.trim() || `Installed omp ${newVersion}`);
		console.log(markdownReport(report));
	} finally {
		process.off("SIGINT", removeOnSignal);
		process.off("SIGTERM", removeOnSignal);
		await rm(temporaryRoot, { recursive: true, force: true });
	}
}

try {
	await main(parseOptions(process.argv.slice(2)));
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
