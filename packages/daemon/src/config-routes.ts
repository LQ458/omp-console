import type {
	ConfiguredPeer,
	DaemonBusySession,
	DaemonCapabilities,
	DaemonConfigFile,
	DaemonConfigFeatureStatus,
	DaemonConfigResponse,
	OptionalFeatureName,
	QuickAskSource,
} from "@omp-console/protocol";
import * as path from "node:path";
import { type ConfigFlagField, loadDaemonConfigFile, parseDaemonConfigFile, RESERVED_MACHINE_IDS } from "./config";
import { errorResponse, json } from "./api";
import { readJsonBody, RouteError } from "./session-ops/http";
import type { Supervisor } from "./supervisor";
import { atomicWriteFile } from "./workspaces/files";

export const MAX_CONFIG_BODY_BYTES = 64 * 1024;

export interface DaemonConfigRoutesOptions {
	stateDir: string;
	capabilities: DaemonCapabilities;
	/** Effective values of this run; a field named in `flagFields` keeps this value at the next start too. */
	knowledgeRoot?: string;
	projectRoots?: readonly string[];
	quickAskSources?: readonly QuickAskSource[];
	agendaHub?: unknown;
	peers?: readonly ConfiguredPeer[];
	featureOverrides?: Partial<Record<OptionalFeatureName, boolean>>;
	/** Config fields set by CLI flags, which override `config.json` at every start. */
	flagFields?: ReadonlySet<ConfigFlagField>;
	/** This machine's id; a peer may not reuse it. */
	machineId: string;
	/** False on hosts where computer use cannot work (everything except macOS). */
	computerUseSupported: boolean;
	/** Startup's peer credential check (token files must be 0600 regular files holding a device token); throws on failure. */
	checkPeers: (peers: readonly ConfiguredPeer[]) => Promise<void>;
	supervisor: Supervisor;
	restartSupported: boolean;
	requestRestart?: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function invalidBody(error: unknown): Response {
	return error instanceof RouteError && error.message === "request body too large"
		? errorResponse(413, "bad-request", error.message)
		: errorResponse(400, "bad-request", errorText(error));
}

/** The values the next start will use: a flag-set field keeps its flag value, anything else comes from the saved file. */
function nextStart(file: DaemonConfigFile, options: DaemonConfigRoutesOptions) {
	const flagged = (field: ConfigFlagField): boolean => options.flagFields?.has(field) === true;
	const enabled = (name: OptionalFeatureName): boolean => options.featureOverrides?.[name] ?? file.features?.[name] === true;
	return {
		enabled,
		knowledgeRoot: flagged("knowledgeRoot") ? options.knowledgeRoot : file.knowledgeRoot,
		projectRoots: flagged("projectRoots") ? (options.projectRoots ?? []) : (file.projectRoots ?? []),
		quickAskSources: flagged("quickAskSources") ? (options.quickAskSources ?? []) : (file.quickAsk?.sources ?? []),
		agendaHub: flagged("agendaHub") ? options.agendaHub : file.agendaHub,
		peers: flagged("peers") ? (options.peers ?? []) : (file.peers ?? []),
		computerUseSupported: options.computerUseSupported,
	};
}

const FEATURE_FIELDS: Record<OptionalFeatureName, readonly ConfigFlagField[]> = {
	librarian: ["knowledgeRoot", "projectRoots"],
	agenda: ["agendaHub"],
	quickAsk: ["knowledgeRoot", "quickAskSources"],
	peers: ["peers"],
	openrouterDecisions: [],
	computerUse: [],
	overnight: [],
};

function missingRequirements(name: OptionalFeatureName, next: ReturnType<typeof nextStart>): string[] {
	switch (name) {
		case "librarian":
			return [
				...(next.knowledgeRoot === undefined ? ["Notes folder"] : []),
				...(next.projectRoots.length > 0 ? [] : ["at least one Project folder"]),
			];
		case "agenda":
			return next.agendaHub === undefined ? ["task board folder"] : [];
		case "quickAsk":
			return [
				...(next.knowledgeRoot === undefined ? ["Notes folder"] : []),
				...(next.quickAskSources.length > 0 ? [] : ["a source for Ask your notes"]),
			];
		case "peers":
			return next.peers.flatMap(peer => peer.tokenFile === undefined ? [`Other computer token file for ${peer.id}`] : []);
		case "openrouterDecisions":
			return next.enabled("librarian") && missingRequirements("librarian", next).length === 0 ? [] : ["Project search"];
		case "computerUse":
			return next.computerUseSupported ? [] : ["macOS (computer use is macOS-only)"];
		case "overnight":
			return [];
	}
}

function featureStatuses(
	file: DaemonConfigFile,
	options: DaemonConfigRoutesOptions,
): Record<OptionalFeatureName, DaemonConfigFeatureStatus> {
	const next = nextStart(file, options);
	const status = (name: OptionalFeatureName): DaemonConfigFeatureStatus => ({
		configured: file.features?.[name] === true,
		effective: options.capabilities.features[name],
		missing: missingRequirements(name, next),
		overriddenByFlag:
			options.featureOverrides?.[name] !== undefined || FEATURE_FIELDS[name].some(field => options.flagFields?.has(field) === true),
	});
	return {
		librarian: status("librarian"),
		agenda: status("agenda"),
		quickAsk: status("quickAsk"),
		peers: status("peers"),
		openrouterDecisions: status("openrouterDecisions"),
		computerUse: status("computerUse"),
		overnight: status("overnight"),
	};
}

/** Runs the peer checks that startup enforces with exit code 2, so a saved config cannot leave a supervised daemon unable to start. */
async function validatePeersForStart(file: DaemonConfigFile, options: DaemonConfigRoutesOptions): Promise<void> {
	const next = nextStart(file, options);
	const ids = new Set([options.machineId]);
	for (const peer of next.peers) {
		if (RESERVED_MACHINE_IDS.has(peer.id) || ids.has(peer.id)) throw new RouteError("bad-request", `peer ${peer.id}: id is reserved or already used`);
		ids.add(peer.id);
	}
	if (!next.enabled("peers")) return;
	try {
		await options.checkPeers(next.peers);
	} catch (error) {
		throw new RouteError("bad-request", errorText(error));
	}
}

function busySessions(supervisor: Supervisor): DaemonBusySession[] {
	return supervisor.list().flatMap(session =>
		session.state === "streaming" || session.state === "asking" || session.awaitingAnswer
			? [{ id: session.id, cwd: session.cwd, ...(session.title === undefined ? {} : { title: session.title }) }]
			: [],
	);
}

function parseForce(value: unknown): boolean {
	if (value === undefined) return false;
	if (!isRecord(value) || Object.keys(value).some(key => key !== "force") || (value.force !== undefined && typeof value.force !== "boolean")) {
		throw new RouteError("bad-request", "restart body must be an object with an optional boolean force field");
	}
	return value.force === true;
}

export function createDaemonConfigRoutes(
	options: DaemonConfigRoutesOptions,
): (req: Request, url: URL) => Promise<Response | undefined> {
	return async (req, url) => {
		if (url.pathname === "/api/config") {
			if (req.method === "GET") {
				let file: DaemonConfigFile;
				try {
					file = await loadDaemonConfigFile(options.stateDir);
				} catch (error) {
					return errorResponse(500, "internal", errorText(error));
				}
				const response: DaemonConfigResponse = {
					file,
					effective: options.capabilities,
					features: featureStatuses(file, options),
					restart: { supported: options.restartSupported },
				};
				return json(200, response);
			}
			if (req.method !== "PUT") return errorResponse(405, "bad-request", `method ${req.method} not allowed`, { Allow: "GET, PUT" });
			let parsed: DaemonConfigFile;
			try {
				parsed = parseDaemonConfigFile(await readJsonBody(req, MAX_CONFIG_BODY_BYTES), options.stateDir);
				await validatePeersForStart(parsed, options);
			} catch (error) {
				return invalidBody(error);
			}
			try {
				await atomicWriteFile(path.join(options.stateDir, "config.json"), `${JSON.stringify(parsed)}\n`, 0o600);
			} catch (error) {
				return errorResponse(500, "internal", `cannot write config.json: ${errorText(error)}`);
			}
			return json(200, { restartRequired: true });
		}
		if (url.pathname !== "/api/daemon/restart") return undefined;
		if (req.method !== "POST") return errorResponse(405, "bad-request", `method ${req.method} not allowed`, { Allow: "POST" });
		if (!options.restartSupported || options.requestRestart === undefined) {
			return errorResponse(409, "conflict", "restart the daemon manually");
		}
		let force: boolean;
		try {
			force = parseForce(await readJsonBody(req, MAX_CONFIG_BODY_BYTES));
		} catch (error) {
			return invalidBody(error);
		}
		const busy = busySessions(options.supervisor);
		if (busy.length > 0 && !force) {
			return json(409, { error: "daemon has busy sessions", code: "conflict", busySessions: busy });
		}
		setTimeout(() => {
			// A turn accepted between the check above and this tick would be killed without `force`; check again.
			if (!force && busySessions(options.supervisor).length > 0) return;
			options.requestRestart?.();
		}, 0);
		return json(202, { restarting: true });
	};
}
