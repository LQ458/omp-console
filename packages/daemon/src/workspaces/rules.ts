import type { RuleFileResponse, RuleFileWrite, WorkspaceRuleFile } from "@omp-console/protocol";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import * as fs from "node:fs/promises";
import * as fsConstants from "node:fs";
import * as path from "node:path";
import { assertNoSymlinkComponents, atomicWriteFile, UnsafeWorkspacePathError } from "./files";

export const MAX_RULE_FILE_BYTES = 256 * 1024;

export class WorkspaceRuleError extends Error {
	constructor(readonly code: "bad-request" | "not-found" | "internal", message: string) {
		super(message);
	}
}

function validateRelativePath(raw: string): string {
	if (raw.length === 0 || raw.includes("\0") || raw.includes("\\") || path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw)) {
		throw new WorkspaceRuleError("bad-request", "rule path must be relative");
	}
	const parts = raw.split("/");
	if (parts.some(part => part === ".." || part === "." || part === "")) {
		throw new WorkspaceRuleError("bad-request", "rule path contains an invalid component");
	}
	if (parts.some(part => part.startsWith(".") && part !== ".omp" && part !== "rules")) {
		throw new WorkspaceRuleError("bad-request", "rule path contains an invalid component");
	}
	return parts.join("/");
}

function rulePath(raw: string, visibility: RuleFileWrite["visibility"]): string {
	const normalized = validateRelativePath(raw);
	if (visibility === "private") {
		const name = normalized.startsWith(".omp/rules/") ? normalized.slice(".omp/rules/".length) : normalized;
		if (!/^[^/]+\.md$/.test(name) || name === ".md") {
			throw new WorkspaceRuleError("bad-request", "private rule path must be a single .md filename");
		}
		return `.omp/rules/${name}`;
	}
	if (normalized === "AGENTS.md" || normalized === ".omp/AGENTS.md" || /^docs\/[^/]+\.mdc?$/.test(normalized)) {
		return normalized;
	}
	throw new WorkspaceRuleError("bad-request", "shared rules must be AGENTS.md, .omp/AGENTS.md, or a docs/*.md file");
}

async function readFileBounded(filePath: string): Promise<string> {
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(filePath, fsConstants.constants.O_RDONLY | fsConstants.constants.O_NOFOLLOW);
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			throw new WorkspaceRuleError("not-found", "rule file not found");
		}
		throw error;
	}
	try {
		const stat = await handle.stat();
		if (stat.size > MAX_RULE_FILE_BYTES) throw new WorkspaceRuleError("bad-request", "rule file exceeds 256 KB");
		return await handle.readFile("utf8");
	} finally {
		await handle.close();
	}
}

async function gitDiff(root: string, relative: string): Promise<string | undefined> {
	const repo = vcs.git(root);
	if (!repo) return undefined;
	const signal = AbortSignal.timeout(2_000);
	try {
		if (!await repo.headSha(signal)) return undefined;
		return await repo.diffText({ base: "HEAD", files: [relative] }, signal);
	} catch {
		return undefined;
	}
}

function gitExcludePath(root: string): string {
	const info = vcs.gitInfo(root);
	if (!info) throw new WorkspaceRuleError("bad-request", "private rules require a Git workspace");
	return path.join(info.gitDir, "info", "exclude");
}

async function ensurePrivateRuleExcluded(root: string): Promise<void> {
	const exclude = gitExcludePath(root);
	await assertNoSymlinkComponents(path.dirname(path.dirname(exclude)), "info/exclude");
	let content = "";
	try {
		content = await fs.readFile(exclude, "utf8");
	} catch (error) {
		if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
	}
	const lines = content.split(/\r?\n/);
	const seen = new Set<string>();
	const retained = lines.filter(line => {
		if (line !== ".omp/rules/") return true;
		if (seen.has(line)) return false;
		seen.add(line);
		return true;
	});
	if (!seen.has(".omp/rules/")) retained.push(".omp/rules/");
	const updated = retained.join("\n").replace(/\n*$/, "\n");
	if (updated !== content) await atomicWriteFile(exclude, updated, 0o600);
}

export async function listWorkspaceRules(root: string): Promise<WorkspaceRuleFile[]> {
	const rules: WorkspaceRuleFile[] = [];
	for (const [relative, visibility] of [["AGENTS.md", "shared"], [".omp/AGENTS.md", "shared"]] as const) {
		try {
			await assertNoSymlinkComponents(root, relative);
			const stat = await fs.lstat(path.join(root, relative));
			if (stat.isFile() && !stat.isSymbolicLink()) rules.push({ path: relative, visibility });
		} catch (error) {
			if (error instanceof UnsafeWorkspacePathError) continue;
			if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
		}
	}
	for (const [directory, visibility] of [[".omp/rules", "private"], ["docs", "shared"]] as const) {
		const absolute = path.join(root, directory);
		let entries: string[];
		try {
			await assertNoSymlinkComponents(root, directory);
			const stat = await fs.lstat(absolute);
			if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
			entries = await fs.readdir(absolute);
		} catch (error) {
			if (error instanceof UnsafeWorkspacePathError) continue;
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") continue;
			throw error;
		}
		for (const name of entries.sort()) {
			if (!/\.mdc?$/.test(name)) continue;
			const relative = `${directory}/${name}`;
			try {
				await assertNoSymlinkComponents(root, relative);
				const stat = await fs.lstat(path.join(root, relative));
				if (stat.isFile() && !stat.isSymbolicLink()) rules.push({ path: relative, visibility });
			} catch (error) {
				if (error instanceof UnsafeWorkspacePathError) continue;
				if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
			}
		}
	}
	return rules.sort((left, right) => left.path.localeCompare(right.path));
}

export async function readWorkspaceRule(root: string, rawPath: string): Promise<RuleFileResponse> {
	const visibility = rawPath.startsWith(".omp/rules/") ? "private" : "shared";
	const relative = rulePath(rawPath, visibility);
	await assertNoSymlinkComponents(root, relative);
	const filePath = path.join(root, relative);
	const content = await readFileBounded(filePath);
	return {
		path: relative,
		visibility,
		content,
		...(visibility === "shared" ? { diff: await gitDiff(root, relative) } : {}),
	};
}

export async function writeWorkspaceRule(root: string, rawPath: string, input: RuleFileWrite): Promise<void> {
	if (Buffer.byteLength(input.content, "utf8") > MAX_RULE_FILE_BYTES) {
		throw new WorkspaceRuleError("bad-request", "rule file exceeds 256 KB");
	}
	const relative = rulePath(rawPath, input.visibility);
	await assertNoSymlinkComponents(root, relative);
	const filePath = path.join(root, relative);
	let mode = input.visibility === "private" ? 0o600 : 0o644;
	try {
		const stat = await fs.lstat(filePath);
		if (stat.isSymbolicLink()) throw new WorkspaceRuleError("bad-request", "symlink rule files are not allowed");
		if (!stat.isFile()) throw new WorkspaceRuleError("bad-request", "rule path must name a file");
		if (stat.size > MAX_RULE_FILE_BYTES) throw new WorkspaceRuleError("bad-request", "rule file exceeds 256 KB");
		mode = stat.mode & 0o777;
	} catch (error) {
		if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
	}
	if (input.visibility === "private") await ensurePrivateRuleExcluded(root);
	await assertNoSymlinkComponents(root, relative);
	await atomicWriteFile(filePath, input.content, mode);
}
