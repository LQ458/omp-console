#!/usr/bin/env bun
/**
 * omp-console daemon CLI.
 *
 *   bun packages/daemon/src/main.ts [--port 7490] [--state-dir ~/.omp-console] [--owner <tailscale login>]
 *                               [--web-dir <dir>] [--worker-cmd "<exe> [args...]" | '["exe","arg"]']
 *                               [--stalled-after-ms 120000] [--stop-grace-ms 5000] [--max-workers 8] [--notify-turns-over 5]
 *                               [--sleep-after <minutes>] (default 120; 0 disables automatic sleep)
 *                               [--allow-host <name>]... [--push-subject <mailto:... | https://...>]
 *                               [--knowledge-root <path>] [--projects-root <path>]...
 *                               [--schedule-config <path>] [--agenda-hub <tasks-hub checkout>]
 *                               [--librarian on|off] [--agenda on|off] [--quick-ask on|off]
 *                               [--quick-ask-source <siyuan|repo|web|history>]...
 *                               [--peers on|off] [--openrouter-decisions on|off] [--computer-use on|off] [--overnight on|off]
 *                               [--machine <id>[=<name>]] [--peer <id>=<https url>]...
 *                               [--peer-token-file <id>=<0600 path>]...
 *
 * Pair and open a browser: `omp-console pair|open [--state-dir <dir>] [--port <port>]`; inspect a service with `omp-console status|logs`.

 * Binds 127.0.0.1 only. SIGTERM/SIGINT stop every worker first, then exit with 143/130. Logs to stderr; prints one JSON line `{"t":"listening","port":N}` on stdout when ready.
 */
import * as os from "node:os";
import * as path from "node:path";
import * as postmortem from "@oh-my-pi/pi-utils/postmortem";
import type { OptionalFeatureName, QuickAskSource } from "@omp-console/protocol";
import { type ConfigFlagField, type ConfiguredPeer, loadDaemonConfigFile, type DaemonConfigFile, type FeatureSettings, RESERVED_MACHINE_IDS } from "./config";
import { startDaemon, type Daemon } from "./server";
import { normalizeAllowedHosts } from "./auth";
import { createDecisionModel, createSmolTextModel, loadOpenRouterKey } from "./models";
import { listPersistedSessions } from "./recent";
import { DEFAULT_MAX_WORKERS, DEFAULT_SLEEP_AFTER_MINUTES, DEFAULT_STALLED_AFTER_MS } from "./supervisor";
import { requestPairingCode } from "./pairing-control";
import type { PairingCodeInfo } from "./device-auth";


const DEFAULT_PORT = 7490;

interface CliConfig {
	port: number;
	stateDir: string;
	owner: string | undefined;
	knowledgeRoot: string | undefined;
	projectRoots: string[];
	scheduleFile: string | undefined;
	/** tasks-hub checkout; its `.venv/bin/python -m hub.board_io` serves the agenda (HUB_* come from the environment). */
	agendaHub: string | undefined;
	features: FeatureSettings;
	featureOverrides: Partial<Record<OptionalFeatureName, boolean>>;
	/** `config.json` fields replaced by CLI flags; a value saved from the UI for them is ignored at start. */
	flagFields: Set<ConfigFlagField>;
	quickAskSources: QuickAskSource[];
	machine: { id: string; name: string };
	peers: Array<{ id: string; name: string; url: string; tokenFile?: string }>;
	allowHosts: string[];
	pushSubject: string | undefined;
	webDir: string;
	workerCmd: string[];
	maxWorkers: number;
	notifyTurnsOverMinutes: number;
	sleepAfterMinutes: number;
	stalledAfterMs: number;
	stopGraceMs: number | undefined;
}

function fail(message: string): never {
	process.stderr.write(`omp-console-daemon: ${message}\n`);
	process.exit(2);
}

/** Flags that may repeat; every other flag keeps its last value. */
const REPEATABLE = new Set(["--allow-host", "--peer", "--peer-token-file", "--projects-root", "--quick-ask-source"]);

function readFlags(argv: readonly string[]): Map<string, string[]> {
	const flags = new Map<string, string[]>();
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (!arg.startsWith("--")) fail(`unexpected argument ${arg}`);
		const eq = arg.indexOf("=");
		const name = eq === -1 ? arg : arg.slice(0, eq);
		const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
		if (value === undefined) fail(`${name} needs a value`);
		const previous = REPEATABLE.has(name) ? (flags.get(name) ?? []) : [];
		flags.set(name, [...previous, value]);
	}
	return flags;
}

function single(flags: Map<string, string[]>, name: string): string | undefined {
	return flags.get(name)?.at(-1);
}

function integer(flags: Map<string, string[]>, name: string, fallback: number | undefined, min: number, max: number): number | undefined {
	const raw = single(flags, name);
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < min || value > max) fail(`invalid ${name} ${raw}`);
	return value;
}

const MACHINE_ID = /^[a-z][a-z0-9-]{0,23}$/;

/** `--machine id[=name]`; defaults to a generic local identity on every platform. */
function parseMachine(raw: string | undefined): { id: string; name: string } {
	if (raw === undefined) return { id: "local", name: "Local" };
	const [id = "", name] = raw.split("=", 2);
	if (!MACHINE_ID.test(id)) fail(`--machine id must match ${MACHINE_ID}`);
	return { id, name: name?.trim() || id.toUpperCase() };
}

/** `--peer <id>=<https url>` supplies a user-configured remote daemon. */
function parsePeer(raw: string): { id: string; name: string; url: string } {
	const eq = raw.indexOf("=");
	const id = raw.slice(0, eq);
	const url = raw.slice(eq + 1);
	if (eq <= 0 || !MACHINE_ID.test(id)) fail(`--peer needs <id>=<https url> with id matching ${MACHINE_ID}`);
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		fail(`--peer ${id}: invalid URL`);
	}
	if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1") fail(`--peer ${id}: use https (Tailscale Serve) or a loopback URL`);
	return { id, name: id.toUpperCase(), url: parsed.origin };
}

function onOff(raw: string, name: string): boolean {
	if (raw !== "on" && raw !== "off") fail(`${name} must be on or off`);
	return raw === "on";
}

function parseWorkerCmd(raw: string): string[] {
	const text = raw.trim();
	if (text.startsWith("[")) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			fail("--worker-cmd looks like JSON but does not parse");
		}
		if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some(item => typeof item !== "string")) {
			fail("--worker-cmd JSON must be a non-empty array of strings");
		}
		return parsed as string[];
	}
	const parts = text.split(/\s+/).filter(Boolean);
	if (parts.length === 0) fail("--worker-cmd is empty");
	return parts;
}

async function parseConfig(argv: readonly string[]): Promise<CliConfig> {
	const flags = readFlags(argv);
	const known = new Set([
		"--port", "--state-dir", "--owner", "--web-dir", "--worker-cmd", "--stalled-after-ms", "--stop-grace-ms",
		"--max-workers", "--notify-turns-over", "--sleep-after", "--allow-host", "--push-subject", "--knowledge-root",
		"--projects-root", "--schedule-config", "--agenda-hub", "--librarian", "--agenda", "--quick-ask",
		"--quick-ask-source", "--peers", "--openrouter-decisions", "--computer-use", "--overnight", "--machine", "--peer",
	]);
	for (const name of flags.keys()) if (!known.has(name)) fail(`unknown option ${name}`);
	const stateDir = path.resolve(single(flags, "--state-dir") ?? path.join(os.homedir(), ".omp-console"));
	let fileConfig: DaemonConfigFile;
	try {
		fileConfig = await loadDaemonConfigFile(stateDir);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}
	const allowHosts = flags.get("--allow-host") ?? [];
	try {
		normalizeAllowedHosts(allowHosts);
	} catch (err) {
		fail(err instanceof Error ? err.message : String(err));
	}
	const pushSubject = single(flags, "--push-subject");
	if (pushSubject !== undefined && !/^(mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s/]+\S*)$/.test(pushSubject)) {
		fail("--push-subject must be a mailto: address or an https: URL");
	}
	const workerCmd = flags.has("--worker-cmd")
		? parseWorkerCmd(single(flags, "--worker-cmd")!)
		: [process.execPath, path.resolve(import.meta.dir, "../../session-host/src/main.ts")];
	const machine = parseMachine(single(flags, "--machine"));
	const peerTokenFiles = new Map<string, string>();
	for (const raw of flags.get("--peer-token-file") ?? []) {
		const eq = raw.indexOf("=");
		const id = raw.slice(0, eq);
		const file = raw.slice(eq + 1);
		if (eq <= 0 || !MACHINE_ID.test(id) || !file) fail("--peer-token-file needs <peer-id>=<path>");
		if (peerTokenFiles.has(id)) fail(`duplicate --peer-token-file for ${id}`);
		peerTokenFiles.set(id, path.resolve(file));
	}
	const configuredPeers: ConfiguredPeer[] = flags.has("--peer") ? (flags.get("--peer") ?? []).map(parsePeer) : (fileConfig.peers ?? []);
	const peers = configuredPeers.map(peer => {
		const tokenFile = peerTokenFiles.get(peer.id) ?? peer.tokenFile;
		if (!tokenFile) return peer;
		peerTokenFiles.delete(peer.id);
		return { ...peer, tokenFile };
	});
	if (peerTokenFiles.size > 0) fail(`--peer-token-file has no matching --peer ${[...peerTokenFiles.keys()][0]}`);
	// Session keys are `<machine>:<id>`: a peer sharing this machine's id, another peer's id, or a reserved word would
	// send that peer's actions to the wrong daemon.
	const ids = new Set([machine.id]);
	for (const peer of peers) {
		if (RESERVED_MACHINE_IDS.has(peer.id) || ids.has(peer.id)) fail(`--peer ${peer.id}: id is reserved or already used`);
		ids.add(peer.id);
	}
	const feature = (flag: string, name: OptionalFeatureName): boolean => {
		const raw = single(flags, flag);
		return raw === undefined ? (fileConfig.features?.[name] ?? false) : onOff(raw, flag);
	};
	const rawSources = flags.get("--quick-ask-source");
	const quickAskSources = rawSources === undefined ? (fileConfig.quickAsk?.sources ?? []) : rawSources.map(source => {
		if (source !== "siyuan" && source !== "repo" && source !== "web" && source !== "history") {
			fail(`--quick-ask-source must be siyuan, repo, web, or history`);
		}
		return source;
	});
	const agendaHub = flags.has("--agenda-hub")
		? path.resolve(single(flags, "--agenda-hub")!)
		: fileConfig.agendaHub;
	const requestedFeatures: FeatureSettings = {
		librarian: feature("--librarian", "librarian"),
		agenda: feature("--agenda", "agenda"),
		quickAsk: feature("--quick-ask", "quickAsk"),
		peers: feature("--peers", "peers"),
		openrouterDecisions: feature("--openrouter-decisions", "openrouterDecisions"),
		computerUse: feature("--computer-use", "computerUse") || process.env.OMP_CONSOLE_COMPUTER_USE === "1",
		overnight: feature("--overnight", "overnight"),
	};
	const featureOverrides: Partial<Record<OptionalFeatureName, boolean>> = {};
	const featureFlags = [
		["--librarian", "librarian"],
		["--agenda", "agenda"],
		["--quick-ask", "quickAsk"],
		["--peers", "peers"],
		["--openrouter-decisions", "openrouterDecisions"],
		["--computer-use", "computerUse"],
		["--overnight", "overnight"],
	] as const;
	for (const [flag, name] of featureFlags) {
		if (flags.has(flag)) featureOverrides[name] = requestedFeatures[name];
	}
	if (process.env.OMP_CONSOLE_COMPUTER_USE === "1") featureOverrides.computerUse = true;
	const knowledgeRoot = flags.has("--knowledge-root")
		? path.resolve(single(flags, "--knowledge-root")!)
		: fileConfig.knowledgeRoot;
	const projectRoots = flags.has("--projects-root")
		? (flags.get("--projects-root") ?? []).map(root => path.resolve(root))
		: (fileConfig.projectRoots ?? []);
	const features: FeatureSettings = {
		...requestedFeatures,
		librarian: requestedFeatures.librarian && knowledgeRoot !== undefined && projectRoots.length > 0,
		quickAsk: requestedFeatures.quickAsk && knowledgeRoot !== undefined && quickAskSources.length > 0,
	};
	return {
		port: integer(flags, "--port", DEFAULT_PORT, 0, 65_535)!,
		stateDir,
		owner: single(flags, "--owner"),
		knowledgeRoot,
		projectRoots,
		scheduleFile: flags.has("--schedule-config") ? path.resolve(single(flags, "--schedule-config")!) : fileConfig.scheduleFile,
		agendaHub,
		features,
		quickAskSources: [...new Set(quickAskSources)],
		featureOverrides,
		flagFields: new Set<ConfigFlagField>([
			...(flags.has("--knowledge-root") ? (["knowledgeRoot"] as const) : []),
			...(flags.has("--projects-root") ? (["projectRoots"] as const) : []),
			...(flags.has("--agenda-hub") ? (["agendaHub"] as const) : []),
			...(flags.has("--schedule-config") ? (["scheduleFile"] as const) : []),
			...(flags.has("--quick-ask-source") ? (["quickAskSources"] as const) : []),
			...(flags.has("--peer") || flags.has("--peer-token-file") ? (["peers"] as const) : []),
		]),
		machine,
		peers,
		allowHosts,
		pushSubject,
		webDir: path.resolve(single(flags, "--web-dir") ?? path.resolve(import.meta.dir, "../../web/dist")),
		workerCmd,
		maxWorkers: integer(flags, "--max-workers", DEFAULT_MAX_WORKERS, 1, Number.MAX_SAFE_INTEGER)!,
		notifyTurnsOverMinutes: integer(flags, "--notify-turns-over", 5, 0, 1440)!,
		stalledAfterMs: integer(flags, "--stalled-after-ms", DEFAULT_STALLED_AFTER_MS, 1, 86_400_000)!,
		stopGraceMs: integer(flags, "--stop-grace-ms", undefined, 0, 600_000),
		sleepAfterMinutes: integer(flags, "--sleep-after", DEFAULT_SLEEP_AFTER_MINUTES, 0, Math.floor(Number.MAX_SAFE_INTEGER / 60_000))!,
	};
}

/** The tasks-hub variables board_io reads (store URL, user, password file, timezone), passed through as-is. */
function hubEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (key.startsWith("HUB_") && value !== undefined) env[key] = value;
	return env;
}

function log(message: string): void {
	process.stderr.write(`${new Date().toISOString()} ${message}\n`);
}

function pairingCodeFile(stateDir: string): string {
	return path.resolve(stateDir) === path.join(os.homedir(), ".omp-console")
		? "~/.omp-console/pairing-code"
		: path.join(stateDir, "pairing-code");
}

function pairingLink(port: number, code: string): string {
	return `http://127.0.0.1:${port}/#pair=${encodeURIComponent(code)}`;
}

function consoleOptions(command: string, args: readonly string[]): { stateDir: string; port: number } {
	const flags = readFlags(args);
	for (const name of flags.keys()) if (name !== "--state-dir" && name !== "--port") fail(`unknown ${command} option ${name}`);
	return {
		stateDir: path.resolve(single(flags, "--state-dir") ?? path.join(os.homedir(), ".omp-console")),
		port: integer(flags, "--port", DEFAULT_PORT, 1, 65_535)!,
	};
}

function openBrowser(url: string): boolean {
	const command = process.platform === "darwin"
		? ["open", url]
		: process.platform === "linux" && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
			? ["xdg-open", url]
			: undefined;
	if (!command) return false;
	try {
		return Bun.spawnSync(command, { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
	} catch {
		return false;
	}
}

async function requestFreshPairing(command: "pair" | "open", args: readonly string[]): Promise<void> {
	const { stateDir, port } = consoleOptions(command, args);
	try {
		const pairing = await requestPairingCode(stateDir);
		const url = pairingLink(port, pairing.code);
		const browserOpened = command === "open" && openBrowser(url);
		if (process.stdout.isTTY) {
			const remainingMinutes = Math.max(1, Math.ceil((pairing.expiresAt - Date.now()) / 60_000));
			process.stdout.write(`pairing code: ${pairing.code} (valid ${remainingMinutes} min)\nPair this browser: ${url}\n`);
			if (command === "open" && !browserOpened) process.stdout.write("No desktop browser was opened. Open the link above in a browser.\n");
		} else {
			process.stdout.write(`pairing code issued, see ${pairingCodeFile(stateDir)}\n`);
			if (browserOpened) process.stdout.write("A browser was opened for pairing.\n");
		}
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}
}

async function showStatus(args: readonly string[]): Promise<void> {
	const { port } = consoleOptions("status", args);
	const base = `http://127.0.0.1:${port}`;
	try {
		const response = await fetch(`${base}/api/pair/status`, { signal: AbortSignal.timeout(3_000) });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		await response.body?.cancel();
		process.stdout.write(`omp-console daemon is responding at ${base}.\nUse Settings > Devices in the paired browser to manage access.\n`);
	} catch {
		process.stdout.write(`omp-console daemon is not responding at ${base}.\nStart the daemon or check its service with \`omp-console logs\`.\n`);
		process.exitCode = 1;
	}
}

async function showLogs(): Promise<void> {
	let command: string[];
	if (process.platform === "linux") {
		command = ["journalctl", "--user", "-u", "omp-console.service", "-n", "100", "--no-pager"];
	} else if (process.platform === "darwin") {
		const file = path.join(os.homedir(), "Library", "Logs", "omp-console", "daemon.log");
		if (!(await Bun.file(file).exists())) {
			process.stdout.write(`No LaunchAgent log exists at ${file}. In plain mode, read the daemon terminal output.\n`);
			return;
		}
		command = ["tail", "-n", "100", file];
	} else {
		process.stderr.write("Managed omp-console logs are supported on macOS and Linux.\n");
		process.exitCode = 1;
		return;
	}
	try {
		const child = Bun.spawn(command, { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
		const status = await child.exited;
		if (status !== 0) process.exitCode = status;
	} catch (error) {
		process.stderr.write(`Could not read service logs: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}

const argv = Bun.argv.slice(2);
if (argv[0] === "pair" || argv[0] === "open") {
	const command = argv.shift() as "pair" | "open";
	await requestFreshPairing(command, argv);
	process.exit(process.exitCode ?? 0);
}
if (argv[0] === "status" || argv[0] === "logs") {
	const command = argv.shift()!;
	if (command === "status") await showStatus(argv);
	else {
		const flags = readFlags(argv);
		if (flags.size > 0) fail("logs does not accept options");
		await showLogs();
	}
	process.exit(process.exitCode ?? 0);
}
const config = await parseConfig(argv);
let startupPairing: PairingCodeInfo | undefined;

let activeDaemon: Daemon | undefined;
const stopAfterRestart = (): void => {
	const current = activeDaemon;
	if (current === undefined) {
		setTimeout(stopAfterRestart, 10);
		return;
	}
	void current.stop().then(
		() => process.exit(0),
		error => {
			log(`supervised restart shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
			process.exit(1);
		},
	);
};
const daemon = await startDaemon({
	port: config.port,
	stateDir: config.stateDir,
	owner: config.owner,
	featureOverrides: config.featureOverrides,
	configFlagFields: config.flagFields,
	// The config route already deferred this past its 202 response.
	requestRestart: stopAfterRestart,
	knowledgeRoot: config.knowledgeRoot,
	projectRoots: config.projectRoots,
	scheduleConfig: config.scheduleFile,
	agendaHub:
		config.agendaHub === undefined
			? undefined
			: { python: path.join(config.agendaHub, ".venv", "bin", "python"), cwd: config.agendaHub, env: hubEnv() },
	features: config.features,
	quickAskSources: config.quickAskSources,
	backgroundModels: config.features.librarian
		? async modelControl => {
				const context = await modelControl.backgroundModelContext();
				const text = createSmolTextModel(context);
				const keyLoader = async () =>
					config.features.openrouterDecisions
						? (await loadOpenRouterKey()) ?? (await context.registry.authStorage.getApiKey("openrouter").catch(() => undefined))
						: undefined;
				return { text, decision: await createDecisionModel({ text, keyLoader }) };
			}
		: undefined,
	machine: config.machine,
	peers: config.peers,
	allowHosts: config.allowHosts,
	pushSubject: config.pushSubject,
	webDir: config.webDir,
	workerCmd: config.workerCmd,
	maxWorkers: config.maxWorkers,
	notifyTurnsOverMs: config.notifyTurnsOverMinutes * 60_000,
	sleepAfterMinutes: config.sleepAfterMinutes,
	listRecent: listPersistedSessions,
	stalledAfterMs: config.stalledAfterMs,
	stopGraceMs: config.stopGraceMs,
	onPairingCode(pairing) {
		if (process.stdout.isTTY) startupPairing = pairing;
		else log(`pairing code issued, see ${pairingCodeFile(config.stateDir)}`);
	},

	log,
}).catch((err: unknown) => fail(`failed to start: ${err instanceof Error ? err.message : String(err)}`));
activeDaemon = daemon;

// omp's postmortem module owns SIGINT/SIGTERM/SIGHUP (exit codes 130/143/129) and fatal errors; its cleanup
// pass awaits this callback before the process exits, so every worker is stopped on any of those paths.
postmortem.register("omp-console-daemon", () => daemon.stop());

log(`omp-console daemon listening on ${daemon.url} (state ${config.stateDir}, web ${config.webDir})`);
process.stdout.write(`${JSON.stringify({ t: "listening", port: daemon.port })}\n`);

if (startupPairing !== undefined && process.stdout.isTTY) {
	process.stdout.write(`Pair this browser: ${pairingLink(daemon.port, startupPairing.code)}\n`);
}
