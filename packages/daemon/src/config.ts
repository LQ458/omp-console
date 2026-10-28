import * as fs from "node:fs/promises";
import * as path from "node:path";
import { OPTIONAL_FEATURE_NAMES, type ConfiguredPeer, type DaemonConfigFile, type OptionalFeatureName, type QuickAskSource } from "@omp-console/protocol";
export type { ConfiguredPeer, DaemonConfigFile };

export interface FeatureSettings {
	librarian: boolean;
	agenda: boolean;
	quickAsk: boolean;
	peers: boolean;
	openrouterDecisions: boolean;
	computerUse: boolean;
	overnight: boolean;
}

/** Peer ids that would collide with routing words. */
export const RESERVED_MACHINE_IDS: ReadonlySet<string> = new Set(["local", "link"]);

/** `config.json` fields a CLI flag can override at start. */
export type ConfigFlagField = "knowledgeRoot" | "projectRoots" | "agendaHub" | "scheduleFile" | "quickAskSources" | "peers";

const FEATURE_NAMES: readonly OptionalFeatureName[] = OPTIONAL_FEATURE_NAMES;
const QUICK_ASK_SOURCES = ["siyuan", "repo", "web", "history"] as const;
const MACHINE_ID = /^[a-z][a-z0-9-]{0,23}$/;

export class DaemonConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DaemonConfigError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
	for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new DaemonConfigError(`${where}: unknown field ${key}`);
}

function configPath(value: unknown, stateDir: string, name: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new DaemonConfigError(`${name} must be a non-empty path`);
	return path.resolve(stateDir, value);
}

function peer(value: unknown, index: number, stateDir: string): ConfiguredPeer {
	const where = `peers[${index}]`;
	if (!isRecord(value)) throw new DaemonConfigError(`${where} must be an object`);
	onlyKeys(value, ["id", "name", "url", "tokenFile"], where);
	if (typeof value.id !== "string" || !MACHINE_ID.test(value.id)) throw new DaemonConfigError(`${where}.id must match ${MACHINE_ID}`);
	if (value.name !== undefined && (typeof value.name !== "string" || value.name.trim() === "")) {
		throw new DaemonConfigError(`${where}.name must be a non-empty string`);
	}
	if (typeof value.url !== "string") throw new DaemonConfigError(`${where}.url must be a URL`);
	let parsed: URL;
	try {
		parsed = new URL(value.url);
	} catch {
		throw new DaemonConfigError(`${where}.url is invalid`);
	}
	if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1") {
		throw new DaemonConfigError(`${where}.url must use https or a loopback URL`);
	}
	return {
		id: value.id,
		name: typeof value.name === "string" ? value.name.trim() : value.id.toUpperCase(),
		url: parsed.origin,
		...(value.tokenFile === undefined ? {} : { tokenFile: configPath(value.tokenFile, stateDir, `${where}.tokenFile`) }),
	};
}

export function parseDaemonConfigFile(value: unknown, stateDir: string): DaemonConfigFile {
	if (!isRecord(value)) throw new DaemonConfigError("config.json must contain a JSON object");
	onlyKeys(value, ["features", "quickAsk", "knowledgeRoot", "projectRoots", "scheduleFile", "agendaHub", "peers"], "config.json");
	const result: DaemonConfigFile = {};
	if (value.features !== undefined) {
		if (!isRecord(value.features)) throw new DaemonConfigError("features must be an object");
		onlyKeys(value.features, FEATURE_NAMES, "features");
		const features: Partial<FeatureSettings> = {};
		for (const name of FEATURE_NAMES) {
			const enabled = value.features[name];
			if (enabled !== undefined) {
				if (typeof enabled !== "boolean") throw new DaemonConfigError(`features.${name} must be a boolean`);
				features[name] = enabled;
			}
		}
		result.features = features;
	}
	if (value.quickAsk !== undefined) {
		if (!isRecord(value.quickAsk)) throw new DaemonConfigError("quickAsk must be an object");
		onlyKeys(value.quickAsk, ["sources"], "quickAsk");
		if (value.quickAsk.sources !== undefined) {
			if (!Array.isArray(value.quickAsk.sources) || value.quickAsk.sources.some(source => typeof source !== "string" || !(QUICK_ASK_SOURCES as readonly string[]).includes(source))) {
				throw new DaemonConfigError("quickAsk.sources must contain only siyuan, repo, web, or history");
			}
			result.quickAsk = { sources: [...new Set(value.quickAsk.sources as QuickAskSource[])] };
		} else {
			result.quickAsk = {};
		}
	}
	if (value.knowledgeRoot !== undefined) result.knowledgeRoot = configPath(value.knowledgeRoot, stateDir, "knowledgeRoot");
	if (value.projectRoots !== undefined) {
		if (!Array.isArray(value.projectRoots)) throw new DaemonConfigError("projectRoots must be an array of paths");
		result.projectRoots = value.projectRoots.map((root, index) => configPath(root, stateDir, `projectRoots[${index}]`));
	}
	if (value.scheduleFile !== undefined) result.scheduleFile = configPath(value.scheduleFile, stateDir, "scheduleFile");
	if (value.agendaHub !== undefined) result.agendaHub = configPath(value.agendaHub, stateDir, "agendaHub");
	if (value.peers !== undefined) {
		if (!Array.isArray(value.peers)) throw new DaemonConfigError("peers must be an array");
		result.peers = value.peers.map((entry, index) => peer(entry, index, stateDir));
		const ids = new Set<string>();
		for (const entry of result.peers) {
			if (ids.has(entry.id)) throw new DaemonConfigError(`peers: duplicate id ${entry.id}`);
			ids.add(entry.id);
		}
	}
	return result;
}

export async function loadDaemonConfigFile(stateDir: string): Promise<DaemonConfigFile> {
	const file = path.join(stateDir, "config.json");
	let text: string;
	try {
		text = await fs.readFile(file, "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return {};
		throw new DaemonConfigError(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new DaemonConfigError(`${file}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		return parseDaemonConfigFile(value, stateDir);
	} catch (error) {
		if (error instanceof DaemonConfigError) throw new DaemonConfigError(`${file}: ${error.message}`);
		throw error;
	}
}
