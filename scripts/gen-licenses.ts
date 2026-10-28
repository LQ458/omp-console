import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type JsonRecord = Record<string, unknown>;
type LicenseFile = { file: string; text: string };
type Notice = {
	ecosystem: string;
	name: string;
	version: string;
	license: string;
	licenseUrl?: string;
	files: LicenseFile[];
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspacePaths = ["packages/protocol", "packages/daemon", "packages/session-host", "packages/web"] as const;
const patchedNames = new Set([
	"@oh-my-pi/pi-agent-core",
	"@oh-my-pi/pi-ai",
	"@oh-my-pi/pi-catalog",
	"@oh-my-pi/pi-coding-agent",
	"@oh-my-pi/pi-tui",
	"@oh-my-pi/pi-wire",
]);

function record(value: unknown): JsonRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected an object in dependency metadata");
	return value as JsonRecord;
}

function records(value: unknown): JsonRecord[] {
	return Array.isArray(value) ? value.map(record) : [];
}

function text(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function removeTrailingCommas(source: string): string {
	const output: string[] = [];
	let quoted = false;
	let escaped = false;
	for (let index = 0; index < source.length; index += 1) {
		const character = source[index]!;
		if (quoted) {
			output.push(character);
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === "\"") quoted = false;
			continue;
		}
		if (character === "\"") quoted = true;
		if (character === ",") {
			let next = index + 1;
			while (/\s/.test(source[next] ?? "")) next += 1;
			if (source[next] === "}" || source[next] === "]") continue;
		}
		output.push(character);
	}
	return output.join("");
}

async function readJson(file: string): Promise<JsonRecord> {
	return record(JSON.parse(removeTrailingCommas(await readFile(file, "utf8"))) as unknown);
}

async function exists(file: string): Promise<boolean> {
	try {
		await access(file);
		return true;
	} catch {
		return false;
	}
}

function command(binary: string, args: string[], cwd = root): string {
	const result = spawnSync(binary, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		const output = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim();
		throw new Error(`${binary} ${args.join(" ")} failed${output ? `:\n${output}` : ""}`);
	}
	return result.stdout ?? "";
}

function packageLocator(locator: string): { name: string; version: string } | undefined {
	const separator = locator.lastIndexOf("@");
	if (separator <= 0 || separator === locator.length - 1) return undefined;
	return { name: locator.slice(0, separator), version: locator.slice(separator + 1) };
}

function lockedPackageVersions(lock: JsonRecord): Map<string, Set<string>> {
	const packages = record(lock.packages);
	const versions = new Map<string, Set<string>>();
	for (const value of Object.values(packages)) {
		if (!Array.isArray(value) || typeof value[0] !== "string") continue;
		const parsed = packageLocator(value[0]);
		if (!parsed) continue;
		const byName = versions.get(parsed.name) ?? new Set<string>();
		byName.add(parsed.version);
		versions.set(parsed.name, byName);
	}
	return versions;
}

function packageLicense(value: unknown): { id: string; url?: string } {
	if (typeof value === "string") return { id: value };
	if (typeof value !== "object" || value === null || Array.isArray(value)) return { id: "Not declared" };
	const metadata = value as JsonRecord;
	return { id: text(metadata.type, "Not declared"), ...(typeof metadata.url === "string" ? { url: metadata.url } : {}) };
}

async function licenseFiles(packageRoot: string, explicit?: string): Promise<LicenseFile[]> {
	const candidates = new Set<string>();
	if (explicit) candidates.add(path.resolve(packageRoot, explicit));
	for (const entry of await readdir(packageRoot, { withFileTypes: true })) {
		if (entry.isFile() && /^(?:LICEN[SC]E|COPYING|UNLICENSE)(?:[._-].*)?$/i.test(entry.name)) {
			candidates.add(path.join(packageRoot, entry.name));
		}
	}
	const found: LicenseFile[] = [];
	for (const candidate of [...candidates].sort()) {
		if (!(await exists(candidate))) continue;
		const fileInfo = await Bun.file(candidate).stat();
		if (!fileInfo.isFile() || fileInfo.size > 2_000_000) continue;
		const content = await readFile(candidate, "utf8");
		if (content.trim()) found.push({ file: path.relative(packageRoot, candidate).split(path.sep).join("/"), text: content.trimEnd() });
	}
	return found;
}

async function resolveInstalledPackage(from: string, name: string): Promise<string | undefined> {
	let directory = from;
	for (;;) {
		const candidate = path.join(directory, "node_modules", ...name.split("/"));
		if (await exists(path.join(candidate, "package.json"))) return realpath(candidate);
		const parent = path.dirname(directory);
		if (parent === directory) return undefined;
		directory = parent;
	}
}

function dependencyNames(manifest: JsonRecord): { name: string; optional: boolean }[] {
	const names = new Map<string, boolean>();
	for (const field of ["dependencies", "optionalDependencies"]) {
		const dependencies = manifest[field];
		if (typeof dependencies !== "object" || dependencies === null || Array.isArray(dependencies)) continue;
		for (const name of Object.keys(dependencies)) names.set(name, field === "optionalDependencies");
	}
	const peers = manifest.peerDependencies;
	const peerMeta = typeof manifest.peerDependenciesMeta === "object" && manifest.peerDependenciesMeta !== null
		? manifest.peerDependenciesMeta as JsonRecord
		: {};
	if (typeof peers === "object" && peers !== null && !Array.isArray(peers)) {
		for (const name of Object.keys(peers)) if (!names.has(name)) {
			const metadata = peerMeta[name];
			names.set(name, typeof metadata === "object" && metadata !== null && (metadata as JsonRecord).optional === true);
		}
	}
	return [...names].map(([name, optional]) => ({ name, optional })).sort((a, b) => a.name.localeCompare(b.name));
}

async function collectBunPackages(lock: JsonRecord): Promise<Notice[]> {
	const lockWorkspaces = record(lock.workspaces);
	const lockedVersions = lockedPackageVersions(lock);
	const notices = new Map<string, Notice>();
	const queue: { from: string; name: string; optional: boolean }[] = [];
	for (const workspacePath of workspacePaths) {
		const workspace = record(lockWorkspaces[workspacePath]);
		const dependencies = typeof workspace.dependencies === "object" && workspace.dependencies !== null
			? workspace.dependencies as JsonRecord
			: {};
		for (const name of Object.keys(dependencies).sort()) queue.push({ from: path.join(root, workspacePath), name, optional: false });
	}
	while (queue.length > 0) {
		const current = queue.shift()!;
		if (current.name.startsWith("@omp-console/")) continue;
		const packageRoot = await resolveInstalledPackage(current.from, current.name);
		if (!packageRoot) {
			if (current.optional) continue;
			throw new Error(`Production dependency ${current.name} is missing below ${path.relative(root, current.from)}; run bun install --frozen-lockfile`);
		}
		const manifest = await readJson(path.join(packageRoot, "package.json"));
		const name = text(manifest.name, current.name);
		const version = text(manifest.version);
		if (!version) throw new Error(`Installed package ${name} has no version`);
		if (!lockedVersions.get(name)?.has(version)) throw new Error(`${name}@${version} is not present in bun.lock`);
		const key = `${name}@${version}`;
		if (notices.has(key)) continue;
		const license = packageLicense(manifest.license);
		notices.set(key, {
			ecosystem: "Bun",
			name,
			version,
			license: license.id,
			...(license.url ? { licenseUrl: license.url } : {}),
			files: await licenseFiles(packageRoot, text(manifest.licenseFile) || undefined),
		});
		for (const dependency of dependencyNames(manifest)) {
			queue.push({ from: packageRoot, name: dependency.name, optional: dependency.optional });
		}
	}
	return [...notices.values()];
}

async function collectAndroidNpmPackages(): Promise<Notice[]> {
	const lock = await readJson(path.join(root, "apps/android/package-lock.json"));
	const packages = record(lock.packages);
	const workspace = record(packages[""]);
	const roots = typeof workspace.dependencies === "object" && workspace.dependencies !== null
		? Object.keys(workspace.dependencies as JsonRecord)
		: [];
	const byName = new Map<string, { key: string; manifest: JsonRecord }[]>();
	for (const [key, value] of Object.entries(packages)) {
		if (!key.startsWith("node_modules/")) continue;
		const manifest = record(value);
		if (manifest.dev === true) continue;
		const name = text(manifest.name, key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length));
		if (!name || typeof manifest.version !== "string") continue;
		const entries = byName.get(name) ?? [];
		entries.push({ key, manifest });
		byName.set(name, entries);
	}
	const queue = [...roots];
	const included = new Set<string>();
	while (queue.length > 0) {
		const name = queue.shift()!;
		for (const entry of byName.get(name) ?? []) {
			if (included.has(entry.key)) continue;
			included.add(entry.key);
			for (const field of ["dependencies", "optionalDependencies"]) {
				const dependencies = entry.manifest[field];
				if (typeof dependencies === "object" && dependencies !== null && !Array.isArray(dependencies)) {
					queue.push(...Object.keys(dependencies));
				}
			}
		}
	}
	const notices: Notice[] = [];
	for (const key of [...included].sort()) {
		const manifest = record(packages[key]);
		const name = text(manifest.name, key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length));
		const version = text(manifest.version);
		const installed = path.join(root, "apps/android", key);
		const license = packageLicense(manifest.license);
		notices.push({
			ecosystem: "Android npm",
			name,
			version,
			license: license.id,
			...(license.url ? { licenseUrl: license.url } : {}),
			files: await exists(path.join(installed, "package.json"))
				? await licenseFiles(installed, text(manifest.licenseFile) || undefined)
				: [],
		});
	}
	return notices;
}

async function collectCargoPackages(): Promise<Notice[]> {
	let output: string;
	try {
		output = command("cargo", ["metadata", "--format-version", "1", "--locked", "--manifest-path", "apps/mac/Cargo.toml"]);
	} catch (cause) {
		if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") {
			console.warn("cargo is unavailable; skipping Cargo dependency notices");
			return [];
		}
		throw cause;
	}
	const metadata = record(JSON.parse(output) as unknown);
	const packages = records(metadata.packages);
	const packageById = new Map(packages.map(item => [text(item.id), item]));
	const nodes = new Map(records(record(metadata.resolve).nodes).map(node => [text(node.id), node]));
	const rootIds = Array.isArray(metadata.workspace_members) ? metadata.workspace_members.filter((item): item is string => typeof item === "string") : [];
	const visited = new Set<string>();
	const pending = [...rootIds];
	while (pending.length > 0) {
		const id = pending.shift()!;
		if (visited.has(id)) continue;
		visited.add(id);
		const node = nodes.get(id);
		for (const dependency of records(node?.deps)) {
			const kinds = records(dependency.dep_kinds);
			if (kinds.length > 0 && !kinds.some(kind => kind.kind === null || kind.kind === "build")) continue;
			const packageId = text(dependency.pkg);
			if (packageId && !visited.has(packageId)) pending.push(packageId);
		}
	}
	const notices: Notice[] = [];
	for (const id of visited) {
		const item = packageById.get(id);
		if (!item || item.source === null || item.source === undefined) continue;
		const name = text(item.name);
		const version = text(item.version);
		const manifest = text(item.manifest_path);
		const packageRoot = path.dirname(manifest);
		const licenseFile = text(item.license_file);
		const license = packageLicense(item.license);
		notices.push({
			ecosystem: "Cargo",
			name,
			version,
			license: license.id,
			...(license.url ? { licenseUrl: license.url } : {}),
			files: await licenseFiles(packageRoot, licenseFile || undefined),
		});
	}
	return notices;
}

const gradleInitScript = String.raw`
import groovy.json.JsonOutput
import groovy.util.XmlSlurper
import org.gradle.api.artifacts.component.ModuleComponentIdentifier
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipFile
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream

def licenseId = { String name, String url ->
    def byUrl = (url =~ /(?i)spdx\.org\/licenses\/([A-Za-z0-9.+-]+)/)
    if (byUrl.find()) return byUrl.group(1)
    def normalized = name.toLowerCase().replaceAll(/[^a-z0-9]+/, " ").trim()
    if (normalized.contains("apache") && normalized.contains("2 0")) return "Apache-2.0"
    if (normalized == "mit license" || normalized == "mit") return "MIT"
    if (normalized.contains("bsd") && normalized.contains("3 clause")) return "BSD-3-Clause"
    if (normalized.contains("bsd") && normalized.contains("2 clause")) return "BSD-2-Clause"
    if (normalized.contains("eclipse public license") && normalized.contains("2 0")) return "EPL-2.0"
    if (normalized.contains("mozilla public license") && normalized.contains("2 0")) return "MPL-2.0"
    return name ?: (url ?: "Not declared")
}

def isLicense = { String name ->
    name ==~ /(?i)(?:META-INF\/)?(?:LICENSE|LICENCE|COPYING|UNLICENSE)(?:[._-].*)?/
}

def collectZip = { File file ->
    def found = []
    if (!file.isFile()) return found
    try {
        def archive = new ZipFile(file)
        try {
            def entries = archive.entries()
            while (entries.hasMoreElements()) {
                def entry = entries.nextElement()
                if (entry.directory) continue
                if (isLicense(entry.name)) {
                    def content = archive.getInputStream(entry).getText("UTF-8").trim()
                    if (content) found << [file: entry.name, text: content]
                } else if (entry.name.toLowerCase().endsWith(".jar")) {
                    def stream = new ZipInputStream(new ByteArrayInputStream(archive.getInputStream(entry).bytes))
                    try {
                        ZipEntry nested
                        while ((nested = stream.nextEntry) != null) {
                            if (!nested.directory && isLicense(nested.name)) {
                                def bytes = new ByteArrayOutputStream()
                                byte[] buffer = new byte[8192]
                                int count
                                while ((count = stream.read(buffer)) != -1) bytes.write(buffer, 0, count)
                                def content = new String(bytes.toByteArray(), "UTF-8").trim()
                                if (content) found << [file: entry.name + "!" + nested.name, text: content]
                            }
                        }
                    } finally { stream.close() }
                }
            }
        } finally { archive.close() }
    } catch (Exception ignored) { }
    return found
}

gradle.projectsEvaluated {
    def rootProject = gradle.rootProject
    rootProject.tasks.register("ompConsoleLicenseInventory") {
    doLast {
        def configurations = []
        rootProject.allprojects.each { project ->
            project.configurations.findAll { it.canBeResolved && (it.name == "debugRuntimeClasspath" || it.name == "releaseRuntimeClasspath") }.each { configurations << it }
            project.buildscript.configurations.findAll { it.canBeResolved && it.name == "classpath" }.each { configurations << it }
        }
        def found = [:]
        configurations.each { configuration ->
            try {
                configuration.incoming.resolutionResult.allComponents.each { component ->
                    if (component.id instanceof ModuleComponentIdentifier) {
                        def id = component.id
                        def key = id.group + ":" + id.module + "@" + id.version
                        if (!found.containsKey(key)) found[key] = [name: id.group + ":" + id.module, version: id.version, licenses: [], files: []]
                    }
                }
                configuration.incoming.artifacts.artifacts.each { artifact ->
                    if (artifact.id.componentIdentifier instanceof ModuleComponentIdentifier) {
                        def id = artifact.id.componentIdentifier
                        def key = id.group + ":" + id.module + "@" + id.version
                        if (found.containsKey(key)) found[key].files.addAll(collectZip(artifact.file))
                    }
                }
            } catch (Exception ignored) { }
        }
        found.each { key, item ->
            def coordinates = key.replaceFirst(/@[^@]+$/, "")
            def parts = coordinates.split(":", 2)
            try {
                def pomFile = rootProject.configurations.detachedConfiguration(rootProject.dependencies.create(parts[0] + ":" + parts[1] + ":" + item.version + "@pom")).singleFile
                def pom = new XmlSlurper(false, false).parse(pomFile)
                pom.licenses.license.each { license ->
                    def name = license.name.text()
                    def url = license.url.text()
                    item.licenses << [id: licenseId(name, url), url: url]
                }
            } catch (Exception ignored) { }
            item.licenses = item.licenses.unique { it.id }.sort { a, b -> a.id <=> b.id }
            item.files = item.files.unique { it.file }.sort { a, b -> a.file <=> b.file }
            item.license = item.licenses.collect { it.id }.join(" OR ") ?: "Not declared"
            item.licenseUrl = item.licenses.collect { it.url }.find { it } ?: ""
            item.remove("licenses")
        }
        println("OMP_CONSOLE_GRADLE_LICENSES=" + JsonOutput.toJson(found.values().toList().sort { a, b -> (a.name + "@" + a.version) <=> (b.name + "@" + b.version) }))
    }
}
}
`;

async function collectGradlePackages(): Promise<Notice[]> {
	const androidRoot = path.join(root, "apps/android");
	const wrapper = path.join(androidRoot, "android/gradlew");
	if (!(await exists(wrapper))) return [];
	const requiredModules = ["node_modules/@capacitor/android/capacitor/build.gradle", "node_modules/@capacitor/local-notifications/android/build.gradle", "node_modules/@capacitor/preferences/android/build.gradle"];
	let hasRequiredModules = true;
	for (const module of requiredModules) if (!(await exists(path.join(androidRoot, module)))) hasRequiredModules = false;
	if (!hasRequiredModules || !(await exists(path.join(androidRoot, "node_modules/.bin/cap")))) {
		command("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], androidRoot);
	}
	if (!(await exists(path.join(androidRoot, "android/capacitor-cordova-android-plugins/cordova.variables.gradle")))) {
		command("npm", ["run", "sync"], androidRoot);
	}
	for (const module of requiredModules) {
		if (!(await exists(path.join(androidRoot, module)))) throw new Error(`Android Gradle dependency ${module} is not installed after npm setup`);
	}
	const temporaryDirectory = await mkdtemp(path.join(root, ".license-generator-"));
	try {
		const initFile = path.join(temporaryDirectory, "licenses.init.gradle");
		await writeFile(initFile, gradleInitScript);
		const output = command("./gradlew", ["--no-daemon", "--console=plain", "--init-script", initFile, "ompConsoleLicenseInventory"], path.join(androidRoot, "android"));
		const line = output.split("\n").find(item => item.startsWith("OMP_CONSOLE_GRADLE_LICENSES="));
		if (!line) throw new Error("Gradle did not produce its dependency license inventory");
		const inventory = records(JSON.parse(line.slice("OMP_CONSOLE_GRADLE_LICENSES=".length)) as unknown);
		return inventory.map(item => ({
			ecosystem: "Gradle",
			name: text(item.name),
			version: text(item.version),
			license: text(item.license, "Not declared"),
			...(text(item.licenseUrl) ? { licenseUrl: text(item.licenseUrl) } : {}),
			files: records(item.files).map(file => ({ file: text(file.file), text: text(file.text) })),
		}));
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}

function fenceFor(value: string): string {
	const runs = value.match(/~+/g) ?? [];
	return "~".repeat(Math.max(3, ...runs.map(run => run.length + 1)));
}

function noticeMarkdown(item: Notice): string {
	const lines = [`## ${item.name}@${item.version}`, "", `- Ecosystem: ${item.ecosystem}`, `- License: ${item.license}`];
	if (item.licenseUrl) lines.push(`- License URL: ${item.licenseUrl}`);
	if (item.files.length === 0) lines.push("- Full license text: not shipped with the resolved package.");
	for (const file of item.files) {
		const fence = fenceFor(file.text);
		lines.push("", `<details><summary>Full license text (${file.file})</summary>`, "", `${fence}text`, file.text, fence, "", "</details>");
	}
	return lines.join("\n");
}

function noticeText(item: Notice): string {
	const lines = [`${item.name}@${item.version}`, `Ecosystem: ${item.ecosystem}`, `License: ${item.license}`];
	if (item.licenseUrl) lines.push(`License URL: ${item.licenseUrl}`);
	if (item.files.length === 0) lines.push("Full license text: not shipped with the resolved package.");
	for (const file of item.files) lines.push("", `----- ${file.file} -----`, file.text);
	return lines.join("\n");
}

const rootPackage = await readJson(path.join(root, "package.json"));
const lock = await readJson(path.join(root, "bun.lock"));
if (text(rootPackage.packageManager) !== "bun@1.4.3") throw new Error("Bun version pin changed; update this generator's lockfile assumptions");
const notices = [
	...(await collectBunPackages(lock)),
	...(await collectAndroidNpmPackages()),
	...(await collectCargoPackages()),
	...(await collectGradlePackages()),
].sort((a, b) => `${a.ecosystem}\0${a.name}\0${a.version}`.localeCompare(`${b.ecosystem}\0${b.name}\0${b.version}`));
const unique = new Map<string, Notice>();
for (const item of notices) unique.set(`${item.ecosystem}\0${item.name}\0${item.version}`, item);
const output = [...unique.values()];
const markdown = [
	"# Third-party notices",
	"",
	"This file lists the production dependencies used by omp-console's Bun workspaces and Android and macOS applications. License texts are included when they are shipped with the resolved dependency.",
	"",
	...output.map(noticeMarkdown),
	"",
].join("\n");
const plainText = [
	"omp-console third-party open-source licenses",
	"",
	...output.map(noticeText),
	"",
].join("\n\n");
await mkdir(path.join(root, "licenses"), { recursive: true });
await mkdir(path.join(root, "packages/web/public"), { recursive: true });
await writeFile(path.join(root, "licenses/THIRD-PARTY-NOTICES.md"), markdown);
await writeFile(path.join(root, "packages/web/public/licenses.txt"), plainText);
console.log(`Wrote notices for ${output.length} dependencies to licenses/THIRD-PARTY-NOTICES.md and packages/web/public/licenses.txt`);
