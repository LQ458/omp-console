import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { getSessionsDir } from "@oh-my-pi/pi-utils/dirs";
import type { SessionSummary } from "@omp-console/protocol";
import { type Daemon, type DaemonOptions, startDaemon } from "../src/server";
import { fakeCmd, makeTmp } from "./helpers";
import { DeviceAuthStore } from "../src/device-auth";

export interface TestDaemon {
	daemon: Daemon;
	stateDir: string;
	agentDir: string;
	sessionsDir: string;
	dir: string;
	/** Rows `GET /api/sessions` reports as recent; mutable. */
	recent: SessionSummary[];
	url: string;
	cookie: string;
	get(path: string, headers?: Record<string, string>): Promise<Response>;
	post(path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
	put(path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
	del(path: string, headers?: Record<string, string>): Promise<Response>;
	unauthenticated(path: string, method?: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
	restoreEnvironment(): void;
}

const daemons: TestDaemon[] = [];

export async function stopTestDaemons(): Promise<void> {
	for (const daemon of daemons.splice(0).reverse()) {
		try {
			await daemon.daemon.stop();
		} finally {
			daemon.restoreEnvironment();
		}
	}
}

export interface TestDaemonOptions extends Partial<DaemonOptions> {
	workerFlags?: string[];
	pair?: boolean;
	recent?: SessionSummary[];
	/** Starts with no configured project or knowledge folders. */
	withoutConfiguredRoots?: boolean;
	/** Session file names (in the sessions dir) this daemon is treated as having hosted before: they resume in place. */
	hostedSessionNames?: string[];
}
async function seedTestDevice(stateDir: string): Promise<string> {
	const store = await DeviceAuthStore.open(stateDir, () => {});
	try {
		const code = fs.readFileSync(path.join(stateDir, "pairing-code"), "utf8").trim();
		const result = await store.pair(code, "test device");
		if (!result.ok) throw new Error(`test daemon device seeding failed: ${result.reason}`);
		return `omc_device=${result.token}`;
	} finally {
		await store.close();
	}
}

export async function startTestDaemon(options: TestDaemonOptions = {}): Promise<TestDaemon> {
	const {
		workerFlags = [],
		recent = [],
		pair = true,
		withoutConfiguredRoots = false,
		hostedSessionNames = [],
		workerEnv = {},
		agentDir: configuredAgentDir,
		stateDir: configuredStateDir,
		...rest
	} = options;
	const recentRows = [...recent];
	const dir = makeTmp();
	const stateDir = configuredStateDir ?? makeTmp("deck-state-");
	const agentDir = configuredAgentDir ?? makeTmp("deck-agent-");
	const isolatedEnvironmentKeys = ["PI_CONFIG_DIR", "PI_CODING_AGENT_DIR", "PI_CONFIG_FILES", "OMP_AUTH_BROKER_URL", "OMP_AUTH_BROKER_TOKEN"] as const;
	const previousEnvironment = new Map(isolatedEnvironmentKeys.map(key => [key, process.env[key]]));
	for (const key of isolatedEnvironmentKeys) delete process.env[key];
	process.env.PI_CONFIG_DIR = `.omp-console-test-${path.basename(dir)}`;
	process.env.PI_CODING_AGENT_DIR = agentDir;

	const sessionsDir = getSessionsDir(agentDir);
	fs.mkdirSync(sessionsDir, { recursive: true });
	if (hostedSessionNames.length > 0) {
		const realSessionsDir = fs.realpathSync(sessionsDir);
		fs.writeFileSync(
			path.join(stateDir, "hosted-sessions.json"),
			JSON.stringify({ version: 1, files: hostedSessionNames.map(name => path.join(realSessionsDir, name)) }),
		);
	}
	const isolatedWorkerEnv = {
		PI_CONFIG_DIR: makeTmp("deck-config-"),
		PI_CODING_AGENT_DIR: agentDir,
		...workerEnv,
	};
	let daemon: Daemon;
	let cookie = "";
	try {
		if (pair) cookie = await seedTestDevice(stateDir);
		daemon = await startDaemon({
			port: 0,
			stateDir,
			// Tests never touch the real Trash.
			systemTrashDir: null,
			workerCmd: fakeCmd(...workerFlags),
			listRecent: async () => [...recentRows],
			stopGraceMs: 300,
			termGraceMs: 300,
			beforeStopTimeoutMs: 300,
			areaTimers: false,
			...(withoutConfiguredRoots ? {} : { knowledgeRoot: makeTmp("deck-knowledge-") }),
			projectRoots: withoutConfiguredRoots ? [] : [makeTmp("deck-projects-")],
			readyTimeoutMs: 5_000,
			restartBackoffMs: [30, 60],
			onPairingCode: () => {},
			modelAvailability: async () => ({ available: true, detail: "test authentication source is configured" }),
			...rest,
			agentDir,
			workerEnv: isolatedWorkerEnv,
		});
	} catch (error) {
		restoreEnvironment();
		throw error;
	}

	function restoreEnvironment(): void {
		for (const [key, value] of previousEnvironment) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}

	const request = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, authenticated = true): Promise<Response> =>
		fetch(`${daemon.url}${path}`, {
			method,
			headers: {
				...(authenticated && cookie ? { Cookie: cookie } : {}),
				...(body === undefined ? {} : { "Content-Type": "application/json" }),
				...headers,
			},
			body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
		});
	const testDaemon: TestDaemon = {
		daemon,
		stateDir,
		dir,
		agentDir,
		sessionsDir,
		recent: recentRows,
		url: daemon.url,
		cookie,
		get: (path, headers) => request("GET", path, undefined, headers),
		post: (path, body, headers) => request("POST", path, body, headers),
		put: (path, body, headers) => request("PUT", path, body, headers),
		del: (path, headers) => request("DELETE", path, undefined, headers),
		unauthenticated: (path, method = "GET", body, headers) => request(method, path, body, headers, false),
		restoreEnvironment,
	};
	daemons.push(testDaemon);
	return testDaemon;
}

export async function pairDaemon(url: string, stateDir: string, label = "test device"): Promise<string> {
	const pairingCode = fs.readFileSync(path.join(stateDir, "pairing-code"), "utf8").trim();
	const pairing = await fetch(`${url}/api/pair`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ code: pairingCode, label }),
	});
	if (!pairing.ok) throw new Error(`test daemon pairing failed with HTTP ${pairing.status}`);
	const setCookie = pairing.headers.get("set-cookie");
	const cookie = setCookie?.slice(0, setCookie.indexOf(";")) ?? "";
	if (!cookie) throw new Error("test daemon did not issue the device cookie");
	return cookie;
}

/** Sends a raw HTTP/1.1 request line verbatim (fetch would normalise `..` and encoded dots) and returns status + head + body. */
export async function rawRequest(
	port: number,
	target: string,
	method = "GET",
	headers: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
	const { promise, resolve, reject } = Promise.withResolvers<{ status: number; text: string }>();
	let received = "";
	const connection = headers.Connection ?? headers.connection ?? "close";
	const extraHeaders = Object.entries(headers)
		.filter(([name]) => name.toLowerCase() !== "host" && name.toLowerCase() !== "connection")
		.map(([name, value]) => `${name}: ${value}`);
	await Bun.connect({
		hostname: "127.0.0.1",
		port,
		socket: {
			open(sock) {
				sock.write([
					`${method} ${target} HTTP/1.1`,
					`Host: 127.0.0.1:${port}`,
					`Connection: ${connection}`,
					...extraHeaders,
					"",
					"",
				].join("\r\n"));
			},
			data(_sock, chunk) {
				received += new TextDecoder().decode(chunk);
			},
			close() {
				const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(received)?.[1] ?? 0);
				resolve({ status, text: received });
			},
			error(_sock, err) {
				reject(err);
			},
		},
	});
	return promise;
}

export interface RawHttpResponse {
	status: number;
	headers: http.IncomingHttpHeaders;
	body: Buffer;
}

/** Reads the wire representation without fetch's automatic content decoding. */
export function rawHttpRequest(
	port: number,
	target: string,
	headers: Record<string, string> = {},
	method = "GET",
): Promise<RawHttpResponse> {
	const { promise, resolve, reject } = Promise.withResolvers<RawHttpResponse>();
	const request = http.request({ hostname: "127.0.0.1", port, path: target, method, headers }, response => {
		const chunks: Buffer[] = [];
		response.on("data", (chunk: Buffer) => chunks.push(chunk));
		response.on("end", () => {
			resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) });
		});
	});
	request.on("error", (error: Error) => reject(error));
	request.end();
	return promise;
}


/**
 * Sends a WebSocket upgrade request over a raw socket and returns the HTTP status line's code, so a refused
 * upgrade (421, 403, 401) is observable exactly; a `WebSocket` client only reports a generic failure.
 */
export async function rawUpgrade(port: number, target: string, headers: Record<string, string> = {}): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const all: Record<string, string> = {
		Host: `127.0.0.1:${port}`,
		Upgrade: "websocket",
		Connection: "Upgrade",
		"Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
		"Sec-WebSocket-Version": "13",
		...headers,
	};
	let received = "";
	await Bun.connect({
		hostname: "127.0.0.1",
		port,
		socket: {
			open(sock) {
				const lines = Object.entries(all).map(([name, value]) => `${name}: ${value}\r\n`);
				sock.write(`GET ${target} HTTP/1.1\r\n${lines.join("")}\r\n`);
			},
			data(sock, chunk) {
				received += new TextDecoder().decode(chunk);
				const status = /^HTTP\/1\.1 (\d{3})/.exec(received)?.[1];
				if (status) {
					resolve(Number(status));
					sock.end();
				}
			},
			close() {
				resolve(0);
			},
			error(_sock, err) {
				reject(err);
			},
		},
	});
	return promise;
}
