import type { GateAuditEntry, GateStatusResponse } from "@omp-console/protocol";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const SESSION_TYPES = ["interactive", "subagent", "scheduled"] as const;
const SHADOW_MODES: GateStatusResponse["modes"] = {
	interactive: "shadow",
	subagent: "shadow",
	scheduled: "shadow",
};
const EVIDENCE = "shadow recommended: 2.31 prompts/message vs 2.25 rollout threshold";
const MAX_AUDIT_ENTRIES = 200;
const MAX_AUDIT_TAIL_BYTES = 2 * 1024 * 1024;
const VALID_MODES = new Set(["shadow", "enforce", "deny-park"]);
const VERDICTS = new Map<string, GateAuditEntry["verdict"]>([
	["allow", "allow"],
	["allowed", "allow"],
	["ask", "ask"],
	["deny", "deny"],
	["denied", "deny"],
	["would-ask", "would-ask"],
	["would_ask", "would-ask"],
	["would-deny", "would-deny"],
	["would_deny", "would-deny"],
]);

export interface GateOptions {
	/** Defaults to `~/.local/share/agent-action-gate`. */
	installDir?: string;
	/** omp extension that loads the gate; its import path names the version. Default `~/.omp/agent/extensions/action-gate.ts`. */
	extensionFile?: string;
	/** Explicit version file (tests); otherwise the extension file, then `<installDir>/version`. */
	versionFile?: string;
	/** Config path; defaults to `~/.config/agent-action-gate/config.json`. */
	configPath?: (installDir: string, version: string) => string;
	/** Defaults to `~/.agent-action-gate`. */
	stateDir?: string;
	/** Defaults to `<stateDir>/audit.jsonl`. */
	auditFile?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalText(value: unknown, limit: number): string | undefined {
	return typeof value === "string" && value.length > 0 ? value.slice(0, limit) : undefined;
}

function mode(value: unknown): GateStatusResponse["modes"][typeof SESSION_TYPES[number]] | undefined {
	return typeof value === "string" && VALID_MODES.has(value)
		? (value as GateStatusResponse["modes"][typeof SESSION_TYPES[number]])
		: undefined;
}

function readModes(raw: unknown): GateStatusResponse["modes"] {
	// v0.6 config: `enforce: { interactive: bool, subagent: bool, scheduled: bool }`; false = shadow.
	if (isObject(raw) && isObject(raw.enforce)) {
		const enforce = raw.enforce;
		const modes = { ...SHADOW_MODES };
		for (const sessionType of SESSION_TYPES) if (enforce[sessionType] === true) modes[sessionType] = "enforce";
		return modes;
	}
	const source = isObject(raw) && isObject(raw.modes) ? raw.modes : raw;
	const modes = { ...SHADOW_MODES };
	if (!isObject(source)) return modes;
	for (const sessionType of SESSION_TYPES) {
		const value = mode(source[sessionType]);
		if (value) modes[sessionType] = value;
	}
	return modes;
}

/** v0.6 logs shadow verdicts as `allow` with a `shadow: would deny (...)` / `shadow: would ask (...)` reason. */
function verdictOf(rawVerdict: string, reason: unknown): GateAuditEntry["verdict"] | undefined {
	const verdict = VERDICTS.get(rawVerdict.toLowerCase());
	if (verdict === "allow" && typeof reason === "string") {
		if (/^shadow: would deny\b/i.test(reason)) return "would-deny";
		if (/^shadow: would ask\b/i.test(reason)) return "would-ask";
	}
	return verdict;
}

function mapAuditEntry(raw: unknown): GateAuditEntry | undefined {
	if (!isObject(raw)) return undefined;
	const rawVerdict = raw.verdict ?? raw.decision;
	if (typeof rawVerdict !== "string") return undefined;
	const verdict = verdictOf(rawVerdict, raw.reason);
	if (!verdict) return undefined;
	const at = typeof raw.at === "number" && Number.isFinite(raw.at)
		? raw.at
		: typeof raw.ts === "number" && Number.isFinite(raw.ts)
			? raw.ts
			: typeof raw.timestamp === "string" ? Date.parse(raw.timestamp) : Number.NaN;
	if (!Number.isFinite(at) || at < 0) return undefined;
	const kinds = Array.isArray(raw.kinds)
		? raw.kinds.filter((item): item is string => typeof item === "string").slice(0, 32)
		: typeof raw.kind === "string" ? [raw.kind] : [];
	const summary = optionalText(raw.summary ?? raw.reason, 1000);
	if (!summary) return undefined;
	const entry: GateAuditEntry = { at, verdict, kinds, summary };
	const target = optionalText(raw.target, 2048);
	const sessionId = optionalText(raw.sessionId ?? raw.session_id ?? raw.session, 128);
	if (target !== undefined) entry.target = target;
	if (sessionId !== undefined) entry.sessionId = sessionId;
	return entry;
}

async function readOptional(file: string): Promise<string | undefined> {
	try {
		return await Bun.file(file).text();
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

async function readAudit(file: string): Promise<GateAuditEntry[]> {
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(file, "r");
		const { size } = await handle.stat();
		const start = Math.max(0, size - MAX_AUDIT_TAIL_BYTES);
		const length = size - start;
		const buffer = Buffer.allocUnsafe(length);
		const { bytesRead } = await handle.read(buffer, 0, length, start);
		const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n").filter(Boolean).slice(-MAX_AUDIT_ENTRIES);
		const entries: GateAuditEntry[] = [];
		for (const line of lines) {
			try {
				const entry = mapAuditEntry(JSON.parse(line) as unknown);
				if (entry) entries.push(entry);
			} catch {
				// An incomplete or corrupt audit line does not hide later valid entries.
			}
		}
		return entries;
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
		throw error;
	} finally {
		await handle?.close();
	}
}

async function readVersion(installDir: string, configured?: string, extensionFile?: string): Promise<string | undefined> {
	const valid = (version: string): string | undefined => (/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/.test(version) ? version : undefined);
	if (!configured && extensionFile) {
		// The omp extension re-exports the frozen copy: `export { default } from ".../agent-action-gate/<ver>/src/..."`.
		const text = await readOptional(extensionFile);
		const match = text?.match(/agent-action-gate\/([^/"']+)\/src\//);
		if (match) return valid(match[1]!);
	}
	const candidates = configured ? [configured] : [path.join(installDir, "version"), path.join(installDir, "VERSION")];
	for (const file of candidates) {
		const text = await readOptional(file);
		if (text === undefined) continue;
		return valid(text.trim());
	}
	return undefined;
}

export async function readGateStatus(options: GateOptions = {}): Promise<GateStatusResponse> {
	const home = os.homedir();
	const installDir = options.installDir ?? path.join(home, ".local", "share", "agent-action-gate");
	const extensionFile = options.extensionFile ?? (options.installDir ? undefined : path.join(home, ".omp", "agent", "extensions", "action-gate.ts"));
	const stateDir = options.stateDir ?? path.join(home, ".agent-action-gate");
	const auditFile = options.auditFile ?? path.join(stateDir, "audit.jsonl");
	const version = await readVersion(installDir, options.versionFile, extensionFile);
	const result: GateStatusResponse = {
		installed: version !== undefined,
		modes: { ...SHADOW_MODES },
		audit: (await readAudit(auditFile)).reverse(),
		evidence: EVIDENCE,
	};
	if (version === undefined) return result;
	result.version = version;
	const configFile = options.configPath?.(installDir, version) ?? path.join(home, ".config", "agent-action-gate", "config.json");
	const configText = await readOptional(configFile);
	if (configText === undefined) {
		// The gate treats a missing config as enforce everywhere.
		result.modes = { interactive: "enforce", subagent: "enforce", scheduled: "enforce" };
		return result;
	}
	try {
		result.modes = readModes(JSON.parse(configText) as unknown);
	} catch {
		// An invalid config blocks every effect in the gate; deck cannot show that as a mode and keeps shadow.
	}
	return result;
}
