/**
 * Launch contract parser (see `packages/protocol/src/worker.ts`). Secrets arrive in the first stdin line,
 * never in argv or the environment.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkerLaunchSecrets, WorkerOvernightOptions } from "@omp-console/protocol";
import { ROOM_ID_BYTES, ROOM_KEY_BYTES, WRITE_TOKEN_BYTES } from "@oh-my-pi/pi-wire";

export class LaunchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LaunchError";
	}
}

export interface ForkSource {
	sessionFile: string;
	entryId?: string;
}

export interface WorkerLaunch {
	cwd: string;
	relay: string;
	roomId: string;
	/** Absolute path of a persisted session to continue. */
	resumeFile?: string;
	fork?: ForkSource;
	/** Optional model selector from the daemon; absent uses the user's configured default. */
	model?: string;
	/** Agenda custom tools are added only by the daemon's feature gate. */
	agendaTools: boolean;
	/** Computer use is disabled unless explicitly enabled by the daemon or environment. */
	computerUse: boolean;
	/** Limit tools exposed by the host for restricted worker sessions. */
	toolAllowlist?: string[];
	overnight?: WorkerOvernightOptions;
	roomKey: Uint8Array;
	writeToken: Uint8Array;
	deviceToken: string;
}

const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const TOOL_NAME_RE = /^[a-z_][a-z0-9_]{0,63}$/;
const OVERNIGHT_QUIET = new Set(["normal", "quiet", "silent"]);

function parseOvernightOptions(value: unknown): WorkerOvernightOptions | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new LaunchError("overnight options require askTimeoutSec 1-86400 and a supported quiet mode");
	}
	const record = value as Record<string, unknown>;
	const askTimeoutSec = record.askTimeoutSec;
	const quiet = record.quiet;
	if (
		typeof askTimeoutSec !== "number" ||
		!Number.isSafeInteger(askTimeoutSec) ||
		askTimeoutSec < 1 ||
		askTimeoutSec > 86_400 ||
		typeof quiet !== "string" ||
		!OVERNIGHT_QUIET.has(quiet)
	) {
		throw new LaunchError("overnight options require askTimeoutSec 1-86400 and a supported quiet mode");
	}
	return { askTimeoutSec, quiet: quiet as WorkerOvernightOptions["quiet"] };
}

export function parseLaunchSecrets(line: string): WorkerLaunchSecrets {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		throw new LaunchError("first stdin line must be a launch-secrets JSON object");
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new LaunchError("first stdin line must be a launch-secrets JSON object");
	}
	const record = value as Record<string, unknown>;
	if (record.t !== "launch" || typeof record.roomKey !== "string" || typeof record.writeToken !== "string" ||
		typeof record.deviceToken !== "string") {
		throw new LaunchError("first stdin line must contain launch roomKey, writeToken, and deviceToken strings");
	}
	const deviceToken = validateDeviceToken(record.deviceToken);
	const overnight = parseOvernightOptions(record.overnight);
	return {
		t: "launch",
		roomKey: record.roomKey,
		writeToken: record.writeToken,
		deviceToken,
		...(overnight === undefined ? {} : { overnight }),
	};
}

function decodeSecret(name: string, value: string | undefined, bytes: number): Uint8Array {
	if (!value) throw new LaunchError(`${name} is not set`);
	if (!B64URL_RE.test(value)) throw new LaunchError(`${name} must be base64url`);
	const decoded = new Uint8Array(Buffer.from(value, "base64url"));
	if (decoded.byteLength !== bytes) {
		throw new LaunchError(`${name} must decode to ${bytes} bytes, got ${decoded.byteLength}`);
	}
	return decoded;
}

function validateDeviceToken(value: string): string {
	decodeSecret("deviceToken", value, 32);
	if (Buffer.from(value, "base64url").toString("base64url") !== value) {
		throw new LaunchError("deviceToken must be canonical base64url");
	}
	return value;
}

/** `<file>[:<entryId>]`; a path that exists as a whole is never split. */
export function parseForkSpec(spec: string): ForkSource {
	const resolved = path.resolve(spec);
	if (fs.existsSync(resolved)) return { sessionFile: resolved };
	const colon = spec.lastIndexOf(":");
	if (colon <= 0 || colon === spec.length - 1) return { sessionFile: resolved };
	return { sessionFile: path.resolve(spec.slice(0, colon)), entryId: spec.slice(colon + 1) };
}

interface RawArgs {
	cwd?: string;
	relay?: string;
	room?: string;
	resume?: string;
	fork?: string;
	model?: string;
	tools?: string;
	agendaTools?: string;
	computerUse?: string;
}

const FLAGS: Record<string, keyof RawArgs> = {
	"--cwd": "cwd",
	"--relay": "relay",
	"--room": "room",
	"--resume": "resume",
	"--fork": "fork",
	"--model": "model",
	"--tools": "tools",
	"--agenda-tools": "agendaTools",
	"--computer-use": "computerUse",
};

function parseArgv(argv: readonly string[]): RawArgs {
	const raw: RawArgs = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		const eq = arg.indexOf("=");
		const flag = eq === -1 ? arg : arg.slice(0, eq);
		const key = FLAGS[flag];
		if (!key) throw new LaunchError(`unknown argument: ${flag}`);
		const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
		if (value === undefined || value === "") throw new LaunchError(`${flag} needs a value`);
		raw[key] = value;
	}
	return raw;
}

export function parseLaunch(argv: readonly string[], secrets: WorkerLaunchSecrets): WorkerLaunch {
	const raw = parseArgv(argv);
	if (!raw.cwd) throw new LaunchError("--cwd is required");
	if (!raw.relay) throw new LaunchError("--relay is required");
	if (!raw.room) throw new LaunchError("--room is required");
	if (raw.resume && raw.fork) throw new LaunchError("--resume and --fork are mutually exclusive");

	const cwd = path.resolve(raw.cwd);
	if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
		throw new LaunchError(`--cwd is not a directory: ${cwd}`);
	}
	let relayUrl: URL;
	try {
		relayUrl = new URL(raw.relay);
	} catch {
		throw new LaunchError(`--relay is not a URL: ${raw.relay}`);
	}
	if (!["ws:", "wss:", "http:", "https:"].includes(relayUrl.protocol)) {
		throw new LaunchError(`--relay must be ws(s) or http(s): ${raw.relay}`);
	}
	// Host.start() re-derives the id from random bytes, so only a canonical 16-byte base64url id can be pinned.
	const roomBytes = B64URL_RE.test(raw.room) ? Buffer.from(raw.room, "base64url") : undefined;
	if (!roomBytes || roomBytes.byteLength !== ROOM_ID_BYTES || roomBytes.toString("base64url") !== raw.room) {
		throw new LaunchError(`--room must be a canonical base64url id of ${ROOM_ID_BYTES} bytes`);
	}
	const resumeFile = raw.resume ? path.resolve(raw.resume) : undefined;
	if (resumeFile && !fs.statSync(resumeFile, { throwIfNoEntry: false })?.isFile()) {
		throw new LaunchError(`--resume session file not found: ${resumeFile}`);
	}
	const fork = raw.fork ? parseForkSpec(raw.fork) : undefined;
	if (fork && !fs.statSync(fork.sessionFile, { throwIfNoEntry: false })?.isFile()) {
		throw new LaunchError(`--fork session file not found: ${fork.sessionFile}`);
	}
	const roomKey = decodeSecret("roomKey", secrets.roomKey, ROOM_KEY_BYTES);
	const writeToken = decodeSecret("writeToken", secrets.writeToken, WRITE_TOKEN_BYTES);
	const deviceToken = validateDeviceToken(secrets.deviceToken);
	let toolAllowlist: string[] | undefined;
	if (raw.tools !== undefined) {
		toolAllowlist = raw.tools.split(",");
		if (toolAllowlist.length > 32 || toolAllowlist.some(name => !TOOL_NAME_RE.test(name))) {
			throw new LaunchError("--tools must be a comma list of tool names");
		}
	}
	const parseSwitch = (flag: string, value: string | undefined): boolean => {
		if (value === undefined || value === "off") return false;
		if (value === "on") return true;
		throw new LaunchError(`${flag} must be on or off`);
	};
	return {
		cwd,
		relay: raw.relay,
		roomId: raw.room,
		resumeFile,
		fork,
		...(raw.model === undefined ? {} : { model: raw.model }),
		agendaTools: parseSwitch("--agenda-tools", raw.agendaTools),
		computerUse: parseSwitch("--computer-use", raw.computerUse),
		roomKey,
		writeToken,
		deviceToken,
		...(toolAllowlist ? { toolAllowlist } : {}),
		...(secrets.overnight === undefined ? {} : { overnight: secrets.overnight }),
	};
}
