import { constants as fsConstants, type Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SetupResponse } from "@omp-console/protocol";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { json } from "../api";
import type { RecentSessionLister } from "../recent";
import { findExecutable, isWindows } from "../platform";

interface SetupModelSource {
	availableModelCount(): Promise<number>;
	modelRoles(): Promise<Record<string, string>>;
}

export interface SetupRouteOptions {
	agentDir: string;
	sessionsDir: string;
	envKeys: readonly string[];
	listRecent: RecentSessionLister;
	modelControl: SetupModelSource;
	findOmp?: () => Promise<SetupResponse["omp"]>;
	countMcpServers?: () => Promise<number>;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function countPersistedSessions(sessionsDir: string, listRecent: RecentSessionLister): Promise<number> {
	let buckets: Dirent[];
	try {
		buckets = await fs.readdir(sessionsDir, { withFileTypes: true });
	} catch (error) {
		if (isMissing(error)) return 0;
		throw error;
	}
	for (const bucket of buckets) {
		if (bucket.isSymbolicLink() || !bucket.isDirectory()) continue;
		const bucketPath = path.join(sessionsDir, bucket.name);
		let files: Dirent[];
		try {
			files = await fs.readdir(bucketPath, { withFileTypes: true });
		} catch (error) {
			if (isMissing(error)) continue;
			throw error;
		}
		for (const file of files) {
			if (file.name.startsWith(".") || !file.name.endsWith(".jsonl") || (!file.isFile() && !file.isSymbolicLink())) continue;
			try {
				await fs.access(path.join(bucketPath, file.name), fsConstants.R_OK);
			} catch (error) {
				if (!isMissing(error)) throw error;
			}
		}
	}
	return (await listRecent()).length;
}

async function directoryEntryCount(directory: string, kind: "skills" | "extensions"): Promise<number> {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(directory, { withFileTypes: true });
	} catch (error) {
		if (isMissing(error)) return 0;
		throw error;
	}
	let count = 0;
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		if (entry.isSymbolicLink()) {
			count++;
			continue;
		}
		if (kind === "skills") {
			if (entry.isDirectory() || (entry.isFile() && entry.name.endsWith(".md"))) count++;
		} else if (entry.isDirectory() || (entry.isFile() && /\.(?:[cm]?js|ts)$/.test(entry.name))) {
			count++;
		}
	}
	return count;
}

async function countMcpServers(): Promise<number> {
	const { configs } = await loadAllMCPConfigs(process.cwd(), { enableProjectConfig: false });
	let count = 0;
	for (const name in configs) if (Object.hasOwn(configs, name)) count++;
	return count;
}

const OMP_VERSION_TIMEOUT_MS = 5_000;

async function findOmp(): Promise<SetupResponse["omp"]> {
	// PATH first, then where Bun and user installs put it: a service or a `su -` shell often lacks ~/.bun/bin on PATH.
	const executable = findExecutable("omp");
	if (executable === undefined) return { found: false, path: null, version: null, error: null };
	const directory = path.dirname(executable);
	const versionCommand = isWindows && /\.cmd$/i.test(executable)
		? ["cmd.exe", "/d", "/s", "/c", `""${executable}" --version"`]
		: [executable, "--version"];
	try {
		const child = Bun.spawn(versionCommand, {
			stdout: "pipe",
			stderr: "ignore",
			env: { ...process.env, PATH: [directory, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter) },
		});
		const timer = setTimeout(() => child.kill(), OMP_VERSION_TIMEOUT_MS);
		const [versionText, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]).finally(() => clearTimeout(timer));
		const version = exitCode === 0 ? /(?:^|[\s/])v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/.exec(versionText.trim())?.[1] ?? null : null;
		return {
			found: true,
			path: executable,
			version,
			error: version === null ? "omp was found, but `omp --version` did not return a version." : null,
		};
	} catch {
		return { found: true, path: executable, version: null, error: "omp was found, but `omp --version` could not run." };
	}
}

async function readResult<T>(read: () => Promise<T>): Promise<{ value: T | null; error: string | null }> {
	try {
		return { value: await read(), error: null };
	} catch (error) {
		return { value: null, error: errorText(error) };
	}
}

function ownCount(record: Readonly<Record<string, unknown>>): number {
	let count = 0;
	for (const key in record) if (Object.hasOwn(record, key)) count++;
	return count;
}

export function createSetupRoute(options: SetupRouteOptions): (req: Request, url: URL) => Promise<Response | undefined> {
	const defaultAgentDir = path.join(os.homedir(), ".omp", "agent");
	return async (req, url) => {
		if (url.pathname !== "/api/setup") return undefined;
		if (req.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET" } });

		const [omp, sessionScan, skills, extensions, mcpServers] = await Promise.all([
			(options.findOmp ?? findOmp)(),
			readResult(() => countPersistedSessions(options.sessionsDir, options.listRecent)),
			readResult(() => directoryEntryCount(path.join(options.agentDir, "skills"), "skills")),
			readResult(() => directoryEntryCount(path.join(options.agentDir, "extensions"), "extensions")),
			readResult(options.countMcpServers ?? countMcpServers),
		]);
		const availableModels = await readResult(() => options.modelControl.availableModelCount());
		const roleResult = await readResult(() => options.modelControl.modelRoles());
		const roles = roleResult.value;
		const defaultModel = roles?.default ?? null;
		const setupErrors: string[] = [];
		if (skills.error !== null) setupErrors.push(skills.error);
		if (extensions.error !== null) setupErrors.push(extensions.error);
		if (mcpServers.error !== null) setupErrors.push(mcpServers.error);
		if (roleResult.error !== null) setupErrors.push(roleResult.error);
		const body: SetupResponse = {
			omp,
			models: {
				availableCount: availableModels.value,
				defaultModel,
				error: availableModels.error,
			},
			sessions: {
				agentDir: options.agentDir,
				count: sessionScan.value,
				error: sessionScan.error,
			},
			ompSetup: {
				agentDir: options.agentDir,
				defaultAgentDir,
				usesDefaultAgentDir: path.resolve(options.agentDir) === path.resolve(defaultAgentDir),
				defaultModel,
				modelRoles: roles === null ? null : ownCount(roles),
				skills: skills.value,
				extensions: extensions.value,
				mcpServers: mcpServers.value,
				error: setupErrors.length > 0 ? setupErrors.join("; ") : null,
			},
			envKeys: [...options.envKeys],
		};
		return json(200, body);
	};
}
