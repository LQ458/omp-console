/**
 * Test harness: a real worker process against an in-process relay, driven by the real web `GuestClient`.
 * No network, no credentials: the model is the scripted `stub` provider (fixtures/stub-provider.ts), loaded
 * as an extension from an isolated agent dir; config roots never touch `~/.omp`.
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	WorkerAbortResult,
	WorkerCommand,
	WorkerModelResult,
	WorkerPong,
	WorkerRequestResult,
	WorkerStatus,
} from "@omp-console/protocol";
import { formatCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { GuestClient, type GuestSnapshot } from "./collab-web/client";
import { type LocalRelay, startLocalRelay } from "./collab-web/local-relay";
import { killProcessTreeNow, readProcessEntries } from "../src/process-tree-platform";

export type WorkerLine = WorkerStatus | WorkerPong | WorkerModelResult | WorkerAbortResult | WorkerRequestResult;

const MAIN = path.resolve(import.meta.dir, "../src/main.ts");
const STUB_PROVIDER = path.resolve(import.meta.dir, "fixtures/stub-provider.ts");

export const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

export async function waitUntil<T>(
	label: string,
	probe: () => T,
	timeoutMs = 20_000,
	intervalMs = 25,
): Promise<Exclude<T, null | undefined | false | 0 | "">> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value) return value as Exclude<T, null | undefined | false | 0 | "">;
		if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
		await sleep(intervalMs);
	}
}

export interface Room {
	id: string;
	key: Uint8Array;
	token: Uint8Array;
}

export function newRoom(): Room {
	return { id: randomBytes(16).toString("base64url"), key: randomBytes(32), token: randomBytes(16) };
}

export class Fixture {
	readonly root: string;
	readonly agentDir: string;
	readonly cwd: string;
	readonly relay: LocalRelay;
	/** Throwaway `PI_CONFIG_DIR` (a dirname under $HOME) so nothing is ever read from or written to `~/.omp`. */
	readonly configDirName: string;
	readonly #workers: WorkerProcess[] = [];
	readonly #guests: GuestClient[] = [];

	constructor(options: { configYaml?: string } = {}) {
		this.root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-console-session-host-"));
		this.configDirName = `.omp-console-test-${path.basename(this.root)}`;
		this.agentDir = path.join(this.root, "agent");
		this.cwd = path.join(this.root, "project");
		fs.mkdirSync(path.join(this.agentDir, "extensions"), { recursive: true });
		fs.mkdirSync(this.cwd, { recursive: true });
		if (options.configYaml) fs.writeFileSync(path.join(this.agentDir, "config.yml"), options.configYaml);
		fs.symlinkSync(STUB_PROVIDER, path.join(this.agentDir, "extensions", "stub-provider.ts"));
		this.relay = startLocalRelay(0);
	}

	spawn(room: Room, extraArgs: string[] = [], extraEnv: Record<string, string> = {}): WorkerProcess {
		const worker = new WorkerProcess(room, this, extraArgs, extraEnv);
		this.#workers.push(worker);
		return worker;
	}

	link(room: Room): string {
		return formatCollabLink(this.relay.url, room.id, room.key, room.token);
	}

	guest(room: Room, name = "guest"): GuestClient {
		const client = new GuestClient(this.link(room), name);
		this.#guests.push(client);
		client.connect();
		return client;
	}

	async dispose(): Promise<void> {
		for (const guest of this.#guests) guest.close();
		await Promise.all(this.#workers.map(worker => worker.kill()));
		this.relay.stop();
		fs.rmSync(this.root, { recursive: true, force: true });
		fs.rmSync(path.join(os.homedir(), this.configDirName), { recursive: true, force: true });
	}
}

export class WorkerProcess {
	readonly lines: WorkerLine[] = [];
	readonly stderr: string[] = [];
	readonly proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
	readonly exited: Promise<number>;

	constructor(room: Room, fixture: Fixture, extraArgs: string[], extraEnv: Record<string, string>) {
		const env: Record<string, string | undefined> = {
			...process.env,
			PI_CONFIG_DIR: fixture.configDirName,
			PI_CODING_AGENT_DIR: fixture.agentDir,
			...extraEnv,
		};
		delete env.OMP_CONSOLE_ROOM_KEY;
		delete env.OMP_CONSOLE_WRITE_TOKEN;
		delete env.PI_CONFIG_FILES;
		delete env.OMP_AUTH_BROKER_URL;
		delete env.OMP_AUTH_BROKER_TOKEN;
		this.proc = Bun.spawn(
			[
				process.execPath,
				MAIN,
				"--cwd",
				fixture.cwd,
				"--relay",
				fixture.relay.url,
				"--room",
				room.id,
				"--model",
				"stub/stub-model",
				...extraArgs,
			],
			{
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				env,
				windowsHide: true,
			},
		);
		this.proc.stdin.write(
			`${JSON.stringify({
				t: "launch",
				roomKey: Buffer.from(room.key).toString("base64url"),
				writeToken: Buffer.from(room.token).toString("base64url"),
				deviceToken: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
			})}\n`,
		);
		void this.proc.stdin.flush();
		void this.#pump(this.proc.stdout, text => this.#onStdout(text));
		void this.#pump(this.proc.stderr, text => this.stderr.push(text));
		this.exited = this.proc.exited;
	}

	#stdoutBuffer = "";

	#onStdout(text: string): void {
		this.#stdoutBuffer += text;
		for (let nl = this.#stdoutBuffer.indexOf("\n"); nl >= 0; nl = this.#stdoutBuffer.indexOf("\n")) {
			const line = this.#stdoutBuffer.slice(0, nl);
			this.#stdoutBuffer = this.#stdoutBuffer.slice(nl + 1);
			if (!line.trim()) continue;
			this.lines.push(JSON.parse(line) as WorkerLine);
		}
	}

	async #pump(stream: ReadableStream<Uint8Array>, sink: (text: string) => void): Promise<void> {
		const decoder = new TextDecoder();
		for await (const chunk of stream) sink(decoder.decode(chunk, { stream: true }));
	}

	get pid(): number {
		return this.proc.pid;
	}

	send(command: WorkerCommand): void {
		this.proc.stdin.write(`${JSON.stringify(command)}\n`);
		void this.proc.stdin.flush();
	}

	/** Send a request-style command and wait for the reply that carries its `id`. */
	async request<T extends WorkerLine>(command: Extract<WorkerCommand, { id: string }>, timeoutMs = 30_000): Promise<T> {
		const from = this.lines.length;
		this.send(command);
		const reply = await waitUntil(
			`reply to ${command.t} ${command.id}`,
			() => this.lines.slice(from).find(line => "id" in line && line.id === command.id),
			timeoutMs,
		);
		return reply as T;
	}

	find<T extends WorkerLine["t"]>(t: T, from = 0): Extract<WorkerLine, { t: T }> | undefined {
		return this.lines.slice(from).find((line): line is Extract<WorkerLine, { t: T }> => line.t === t);
	}

	ready(timeoutMs = 60_000): Promise<Extract<WorkerStatus, { t: "ready" }>> {
		return waitUntil(`ready (stderr: ${this.stderr.join("").slice(-1500)})`, () => this.find("ready"), timeoutMs);
	}

	async kill(): Promise<void> {
		if (this.proc.exitCode === null) {
			killProcessTreeNow(this.proc.pid);
			await this.proc.exited;
		}
	}
}

export function snapshotText(snapshot: GuestSnapshot): string {
	return JSON.stringify(snapshot.entries);
}

/** Pids of every process whose command line contains `needle`. */
export function pidsMatching(needle: string): number[] {
	return readProcessEntries()
		.filter(entry => entry.commandLine.includes(needle) && entry.pid !== process.pid)
		.map(entry => entry.pid);
}
