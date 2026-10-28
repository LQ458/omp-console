import { afterEach, describe, expect, it } from "bun:test";
import type { DaemonCapabilities, DaemonConfigResponse, DaemonHealth, ListSessionsResponse, SessionSummary } from "@omp-console/protocol";
import * as fs from "node:fs";
import * as path from "node:path";
import { fakeCmd, isAlive, makeTmp } from "./helpers";
import { until } from "./ws-helpers";
import { pairDaemon } from "./harness";

const MAIN = path.join(import.meta.dir, "..", "src", "main.ts");
const SEED = path.join(import.meta.dir, "fixtures", "seed-session.ts");

const children: Array<Bun.Subprocess> = [];

afterEach(async () => {
	for (const child of children.splice(0)) {
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
	}
});

function isolatedEnv(agentDir: string): Record<string, string> {
	return {
		...(process.env as Record<string, string>),
		PI_CONFIG_DIR: `.omp-console-test-${path.basename(agentDir)}`,
		PI_CODING_AGENT_DIR: agentDir,
		OMP_CONSOLE_COMPUTER_USE: "0",
	};
}

async function readListening(child: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<number> {
	const decoder = new TextDecoder();
	let buffered = "";
	for await (const chunk of child.stdout) {
		buffered += decoder.decode(chunk, { stream: true });
		const line = buffered.split("\n").find(l => l.includes('"listening"'));
		if (line) return (JSON.parse(line) as { port: number }).port;
	}
	throw new Error("daemon exited before listening");
}

function startDaemonProcess(args: string[], env: Record<string, string>): Bun.Subprocess<"ignore", "pipe", "pipe"> {
	const child = Bun.spawn([process.execPath, MAIN, "--state-dir", makeTmp("omp-console-state-"), ...args], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env,
	});
	children.push(child);
	return child;
}

async function stopDaemonProcess(child: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<number> {
	if (child.exitCode === null) child.kill("SIGTERM");
	return child.exited;
}
function psListsAny(pids: number[]): boolean {
	const result = Bun.spawnSync(["ps", "-p", pids.join(","), "-o", "pid="]);
	return result.stdout.toString().trim().length > 0;
}

describe("daemon process", () => {
	it("prints the listening line, serves sessions from real omp session files, and stops every worker on SIGTERM", async () => {
		const agentDir = makeTmp("deck-agent-");
		const stateDir = makeTmp("deck-state-");
		const projectDir = makeTmp("deck-proj-");
		const env = isolatedEnv(agentDir);

		const seed = Bun.spawnSync([process.execPath, SEED, projectDir], { env });
		expect(seed.exitCode).toBe(0);
		const seeded = JSON.parse(seed.stdout.toString().trim().split("\n").pop()!) as { file: string; id: string };

		const childPids = path.join(makeTmp(), "children.pids");
		// Workers ignore `stop` and keep a straggler child: shutdown must escalate and sweep the process group.
		const workerCmd = JSON.stringify(fakeCmd("--ignore-stop", "--spawn-child", childPids));
		const proc = startDaemonProcess(
			["--port", "0", "--state-dir", stateDir, "--worker-cmd", workerCmd, "--owner", "alice@example.com", "--stop-grace-ms", "200"],
			env,
		);
		const port = await readListening(proc);
		const base = `http://127.0.0.1:${port}`;
		const cookie = await pairDaemon(base, stateDir);

		// Recent comes from SessionManager.listAll() on the isolated agent dir.
		const list = (await (await fetch(`${base}/api/sessions`, { headers: { Cookie: cookie } })).json()) as ListSessionsResponse;
		expect(list.live).toEqual([]);
		expect(list.recent).toHaveLength(1);
		expect(list.recent[0]).toMatchObject({ id: seeded.id, cwd: projectDir, sessionFile: seeded.file, state: "stopped" });

		const created: SessionSummary[] = [];
		for (let i = 0; i < 2; i++) {
			const res = await fetch(`${base}/api/sessions`, {
				method: "POST",
				headers: { Cookie: cookie, "Content-Type": "application/json" },
				body: JSON.stringify({ cwd: projectDir }),
			});
			expect(res.status).toBe(201);
			created.push((await res.json()) as SessionSummary);
		}
		const health = (await (await fetch(`${base}/api/health`, { headers: { Cookie: cookie } })).json()) as DaemonHealth;
		const workerPids = health.workers.map(w => w.pid);
		expect(workerPids).toHaveLength(2);
		await until(() => fs.existsSync(childPids) && fs.readFileSync(childPids, "utf8").trim().split("\n").length === 2, "two straggler children");
		const stragglers = fs.readFileSync(childPids, "utf8").trim().split("\n").map(Number);
		for (const pid of [...workerPids, ...stragglers]) expect(isAlive(pid)).toBe(true);
		expect(created.map(s => s.id)).not.toContain(seeded.id);

		proc.kill("SIGTERM");
		const code = await proc.exited;
		expect(code).toBe(143); // omp postmortem: 128 + SIGTERM, after the cleanup pass stopped the workers
		expect(psListsAny([...workerPids, ...stragglers])).toBe(false);
	}, 30_000);

	it("rejects bad options with exit code 2", async () => {
		const env = isolatedEnv(makeTmp("deck-agent-"));
		for (const args of [["--bogus", "1"], ["--port", "99999"], ["--port"], ["--worker-cmd", "[1]"], ["--max-workers", "0"], ["--sleep-after", "-1"], ["--sleep-after", "1.5"], ["positional"], ["--allow-host", "*.ts.net"], ["--allow-host"], ["--push-subject", "nope"]]) {
			const proc = startDaemonProcess(args, env);
			expect({ args, code: await proc.exited }).toEqual({ args, code: 2 });
		}
	}, 30_000);
	it("serves normal sessions with every optional route and background worker disabled by default", async () => {
		const env = isolatedEnv(makeTmp("omp-console-agent-"));
		const stateDir = makeTmp("omp-console-state-");
		const proc = startDaemonProcess(["--port", "0", "--state-dir", stateDir, "--worker-cmd", JSON.stringify(fakeCmd())], env);
		try {
			const base = `http://127.0.0.1:${await readListening(proc)}`;
			const cookie = await pairDaemon(base, stateDir);
			const authed = (url: string, init: RequestInit = {}): Promise<Response> =>
				fetch(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), cookie } });
			const capabilities = (await (await authed(`${base}/api/capabilities`)).json()) as DaemonCapabilities;
			expect(capabilities).toEqual({
				features: {
					librarian: false,
					agenda: false,
					quickAsk: false,
					peers: false,
					openrouterDecisions: false,
					overnight: false,
					computerUse: false,
				},
				quickAskSources: [],
			});
			expect((await authed(`${base}/api/sessions`)).status).toBe(200);
			const disabled = [
				{ path: "/api/cards" },
				{ path: "/api/brief" },
				{ path: "/api/agenda/today" },
				{ path: "/api/agenda/todos" },
				{ path: "/api/agenda/ask", method: "POST" },
				{ path: "/api/quick-ask", method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: "hello" }) },
				{ path: "/api/peers" },
				{ path: "/api/overnight/template" },
				{ path: "/api/overnight/preflight?cwd=%2Ftmp" },
			];
			for (const request of disabled) {
				const { path, ...init } = request;
				expect((await authed(`${base}${path}`, init)).status).toBe(404);
			}
			const health = (await (await authed(`${base}/api/health`)).json()) as DaemonHealth;
			expect(health.workers).toEqual([]);
		} finally {
			expect(await stopDaemonProcess(proc)).toBe(143);
		}
	}, 30_000);
	it("enables overnight from saved config and honors an explicit CLI disable", async () => {
		const env = isolatedEnv(makeTmp("omp-console-agent-"));
		const workerCmd = JSON.stringify(fakeCmd());
		const configuredState = makeTmp("omp-console-config-");
		fs.writeFileSync(path.join(configuredState, "config.json"), JSON.stringify({ features: { overnight: true } }));
		const configured = startDaemonProcess(
			["--port", "0", "--state-dir", configuredState, "--worker-cmd", workerCmd],
			env,
		);
		try {
			const base = `http://127.0.0.1:${await readListening(configured)}`;
			const cookie = await pairDaemon(base, configuredState);
			const authed = (url: string): Promise<Response> => fetch(url, { headers: { cookie } });
			const capabilities = (await (await authed(`${base}/api/capabilities`)).json()) as DaemonCapabilities;
			expect(capabilities.features.overnight).toBe(true);
			expect((await authed(`${base}/api/overnight/template`)).status).toBe(200);
		} finally {
			expect(await stopDaemonProcess(configured)).toBe(143);
		}

		const overriddenState = makeTmp("omp-console-config-");
		fs.writeFileSync(path.join(overriddenState, "config.json"), JSON.stringify({ features: { overnight: true } }));
		const overridden = startDaemonProcess(
			["--port", "0", "--state-dir", overriddenState, "--worker-cmd", workerCmd, "--overnight", "off"],
			env,
		);
		try {
			const base = `http://127.0.0.1:${await readListening(overridden)}`;
			const cookie = await pairDaemon(base, overriddenState);
			const authed = (url: string): Promise<Response> => fetch(url, { headers: { cookie } });
			const capabilities = (await (await authed(`${base}/api/capabilities`)).json()) as DaemonCapabilities;
			expect(capabilities.features.overnight).toBe(false);
			expect((await authed(`${base}/api/overnight/template`)).status).toBe(404);
		} finally {
			expect(await stopDaemonProcess(overridden)).toBe(143);
		}
	}, 30_000);

	it("loads state-dir JSON configuration and lets CLI feature/source flags override it", async () => {
		const stateDir = makeTmp("omp-console-config-");
		fs.writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({
			features: { agenda: true, peers: true, quickAsk: true, computerUse: true },
			quickAsk: { sources: ["repo"] },
			knowledgeRoot: "Knowledge",
			peers: [],
		}));
		const env = isolatedEnv(makeTmp("omp-console-agent-"));
		const workerCmd = JSON.stringify(fakeCmd());
		const baseArgs = ["--port", "0", "--state-dir", stateDir, "--worker-cmd", workerCmd];
		const configured = startDaemonProcess(baseArgs, env);
		let cookie = "";
		const authed = (url: string, init: RequestInit = {}): Promise<Response> =>
			fetch(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), cookie } });
		try {
			const base = `http://127.0.0.1:${await readListening(configured)}`;
			cookie = await pairDaemon(base, stateDir);
			const capabilities = (await (await authed(`${base}/api/capabilities`)).json()) as DaemonCapabilities;
			expect(capabilities.features).toMatchObject({ peers: true, quickAsk: true, computerUse: process.platform === "darwin" });
			expect(capabilities.quickAskSources).toEqual(["repo"]);
			expect(capabilities.features.overnight).toBe(false);
			expect((await authed(`${base}/api/overnight/template`)).status).toBe(404);
			const config = (await (await authed(`${base}/api/config`)).json()) as DaemonConfigResponse;
			expect(config.features.agenda).toEqual({
				configured: true,
				effective: false,
				missing: ["task board folder"],
				overriddenByFlag: false,
			});
			expect((await authed(`${base}/api/peers`)).status).toBe(200);
		} finally {
			expect(await stopDaemonProcess(configured)).toBe(143);
		}

		const overridden = startDaemonProcess(
			[...baseArgs, "--peers", "off", "--computer-use", "off", "--quick-ask-source", "history", "--overnight", "on"],
			env,
		);
		try {
			const base = `http://127.0.0.1:${await readListening(overridden)}`;
			const capabilities = (await (await authed(`${base}/api/capabilities`)).json()) as DaemonCapabilities;
			expect(capabilities.features).toMatchObject({ peers: false, quickAsk: true, computerUse: false, overnight: true });
			expect(capabilities.quickAskSources).toEqual(["history"]);
			expect((await authed(`${base}/api/overnight/template`)).status).toBe(200);
			expect((await authed(`${base}/api/peers`)).status).toBe(404);
			const disallowed = await authed(`${base}/api/quick-ask`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ question: "A question", sources: ["repo"] }),
			});
			expect(disallowed.status).toBe(400);
			expect(((await (await authed(`${base}/api/health`)).json()) as DaemonHealth).workers).toEqual([]);
		} finally {
			expect(await stopDaemonProcess(overridden)).toBe(143);
		}
	}, 30_000);

	it("rejects malformed config.json with a clear exit-code-2 error", async () => {
		const stateDir = makeTmp("omp-console-invalid-config-");
		fs.writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({ features: { librarian: "yes" } }));
		const proc = startDaemonProcess(["--port", "0", "--state-dir", stateDir], isolatedEnv(makeTmp("omp-console-agent-")));
		expect(await proc.exited).toBe(2);
		const error = await new Response(proc.stderr).text();
		expect(error).toContain("config.json");
		expect(error).toContain("features.librarian must be a boolean");
	}, 30_000);

	it("keeps fresh pairing links out of noninteractive stdout", async () => {
		const agentDir = makeTmp("deck-agent-");
		const stateDir = makeTmp("deck-state-");
		const env = isolatedEnv(agentDir);
		const daemon = startDaemonProcess(
			["--port", "0", "--state-dir", stateDir, "--worker-cmd", JSON.stringify(fakeCmd())],
			env,
		);
		const base = `http://127.0.0.1:${await readListening(daemon)}`;
		await pairDaemon(base, stateDir);

		const cli = Bun.spawn([process.execPath, MAIN, "pair", "--state-dir", stateDir], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env,
		});
		children.push(cli);
		const output = await new Response(cli.stdout).text();
		expect(await cli.exited).toBe(0);
		const code = fs.readFileSync(path.join(stateDir, "pairing-code"), "utf8").trim();
		expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
		expect(output).toBe(`pairing code issued, see ${path.join(stateDir, "pairing-code")}\n`);
		expect(output).not.toContain(code);
		expect(output).not.toContain("#pair=");

		daemon.kill("SIGTERM");
		expect(await daemon.exited).toBe(143);
	}, 30_000);

	it("applies --max-workers to worker creation", async () => {
		const env = isolatedEnv(makeTmp("deck-agent-"));
		const stateDir = makeTmp("deck-state-");
		const proc = startDaemonProcess(
			["--port", "0", "--state-dir", stateDir, "--worker-cmd", JSON.stringify(fakeCmd()), "--max-workers", "1", "--sleep-after", "0"],
			env,
		);
		const base = `http://127.0.0.1:${await readListening(proc)}`;
		const cookie = await pairDaemon(base, stateDir);
		const sleepSettings = await fetch(`${base}/api/settings/sleep`, { headers: { Cookie: cookie } });
		expect(await sleepSettings.json()).toEqual({ minutes: 0 });
		const create = (): Promise<Response> =>
			fetch(`${base}/api/sessions`, {
				method: "POST",
				headers: { Cookie: cookie, "Content-Type": "application/json" },
				body: JSON.stringify({ cwd: process.cwd() }),
			});

		expect((await create()).status).toBe(201);
		const capped = await create();
		expect(capped.status).toBe(409);
		expect(((await capped.json()) as { code: string }).code).toBe("conflict");
		proc.kill("SIGTERM");
		expect(await proc.exited).toBe(143);
	}, 30_000);

	it("applies every repeated --allow-host, refuses other hosts, and keeps the VAPID key owner-only", async () => {
		const env = isolatedEnv(makeTmp("deck-agent-"));
		const stateDir = makeTmp("deck-state-");
		const proc = startDaemonProcess(
			["--port", "0", "--state-dir", stateDir, "--worker-cmd", JSON.stringify(fakeCmd()), "--allow-host", "a.ts.net", "--allow-host", "B.ts.net:443"],
			env,
		);
		const base = `http://127.0.0.1:${await readListening(proc)}`;
		const cookie = await pairDaemon(base, stateDir);
		const status = async (host: string): Promise<number> =>
			(await fetch(`${base}/api/health`, { headers: { Host: host, Cookie: cookie } })).status;
		expect(await Promise.all(["a.ts.net", "b.ts.net", "c.ts.net", "evil.example"].map(status))).toEqual([200, 200, 421, 421]);
		expect(fs.statSync(path.join(stateDir, "vapid-keys.json")).mode & 0o777).toBe(0o600);
		proc.kill("SIGTERM");
		expect(await proc.exited).toBe(143);
	}, 30_000);
});
