import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { FeatureSettings } from "../src/config";
import type { DaemonCapabilities, DaemonConfigFile, DaemonConfigResponse, DaemonRestartConflict } from "@omp-console/protocol";
import { loadDaemonConfigFile } from "../src/config";
import { startDaemon, type Daemon } from "../src/server";
import { type TestDaemon, startTestDaemon, stopTestDaemons } from "./harness";
import { fakeCmd, makeTmp } from "./helpers";
import { until } from "./ws-helpers";

const restartedDaemons: Daemon[] = [];
const originalSupervised = process.env.OMP_CONSOLE_SUPERVISED;
const originalComputerUse = process.env.OMP_CONSOLE_COMPUTER_USE;

afterEach(async () => {
	await Promise.all(restartedDaemons.splice(0).map(daemon => daemon.stop()));
	await stopTestDaemons();
	if (originalSupervised === undefined) delete process.env.OMP_CONSOLE_SUPERVISED;
	else process.env.OMP_CONSOLE_SUPERVISED = originalSupervised;
	if (originalComputerUse === undefined) delete process.env.OMP_CONSOLE_COMPUTER_USE;
	else process.env.OMP_CONSOLE_COMPUTER_USE = originalComputerUse;
});

function emptyFeatures(overrides: Partial<FeatureSettings> = {}): FeatureSettings {
	return {
		librarian: false,
		agenda: false,
		quickAsk: false,
		peers: false,
		openrouterDecisions: false,
		computerUse: false,
		overnight: false,
		...overrides,
	};
}

function writeConfig(stateDir: string, value: unknown): string {
	fs.mkdirSync(stateDir, { recursive: true });
	const file = path.join(stateDir, "config.json");
	fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
	return file;
}

describe("daemon configuration routes", () => {
	it("reports parsed settings, live requirements, flag overrides, and paired-device auth", async () => {
		delete process.env.OMP_CONSOLE_SUPERVISED;
		delete process.env.OMP_CONSOLE_COMPUTER_USE;
		const stateDir = makeTmp("config-route-state-");
		const tokenFile = path.join(stateDir, "peer-token");
		const peerToken = Buffer.alloc(32, 7).toString("base64url");
		fs.writeFileSync(tokenFile, peerToken, { mode: 0o600 });
		writeConfig(stateDir, {
			features: { librarian: true, agenda: true, quickAsk: true, peers: true, openrouterDecisions: true, computerUse: false, overnight: false },
			quickAsk: { sources: [] },
			peers: [{ id: "studio", name: "Studio", url: "https://peer.example", tokenFile }],
		});
		const daemon = await startTestDaemon({
			stateDir,
			features: emptyFeatures({ librarian: true, agenda: true, quickAsk: true, peers: true, openrouterDecisions: true, computerUse: true }),
			peers: [{ id: "studio", name: "Studio", url: "https://peer.example", tokenFile }],
			featureOverrides: { agenda: false, computerUse: true },
			knowledgeRoot: undefined,
			projectRoots: [],
			quickAskSources: [],
			backgroundModels: undefined,
		});

		const unauthorized = await daemon.unauthenticated("/api/config");
		expect(unauthorized.status).toBe(401);

		const [response, capabilitiesResponse] = await Promise.all([
			daemon.get("/api/config"),
			daemon.get("/api/capabilities"),
		]);
		expect(response.status).toBe(200);
		const config = await response.json() as DaemonConfigResponse;
		const capabilities = await capabilitiesResponse.json() as DaemonCapabilities;
		expect(config.effective).toEqual(capabilities);
		expect(config.file.peers?.[0]).toEqual({ id: "studio", name: "Studio", url: "https://peer.example", tokenFile });
		expect(JSON.stringify(config)).not.toContain(peerToken);
		expect(config.restart).toEqual({ supported: false });
		expect(config.features.librarian).toMatchObject({ configured: true, effective: false, overriddenByFlag: false });
		expect(config.features.librarian.missing).toEqual(["Notes folder", "at least one Project folder"]);
		expect(config.features.agenda).toMatchObject({ configured: true, effective: false, missing: ["task board folder"], overriddenByFlag: true });
		expect(config.features.quickAsk).toMatchObject({ configured: true, effective: false, missing: ["Notes folder", "a source for Ask your notes"] });
		expect(config.features.peers).toMatchObject({ configured: true, effective: true, missing: [] });
		expect(config.features.openrouterDecisions).toMatchObject({ configured: true, effective: false, missing: ["Project search"] });
		// Computer use only exists on macOS; elsewhere the request is reported as unmet.
		expect(config.features.computerUse).toMatchObject({ configured: false, effective: process.platform === "darwin", overriddenByFlag: true });
		expect(config.features.overnight).toEqual({ configured: false, effective: false, missing: [], overriddenByFlag: false });
	});

	it("reports missing peer credentials without preventing the settings UI from starting", async () => {
		const stateDir = makeTmp("peer-config-state-");
		writeConfig(stateDir, {
			features: { peers: true },
			peers: [{ id: "studio", name: "Studio", url: "https://peer.example" }],
		});
		const daemon = await startTestDaemon({
			stateDir,
			features: emptyFeatures({ peers: true }),
			peers: [{ id: "studio", name: "Studio", url: "https://peer.example" }],
		});
		const response = await daemon.get("/api/config");
		const config = await response.json() as DaemonConfigResponse;
		expect(config.features.peers).toEqual({
			configured: true,
			effective: false,
			missing: ["Other computer token file for studio"],
			overriddenByFlag: false,
		});
	});

	it("leaves config unchanged on invalid or oversized PUT and reloads a valid file at next startup", async () => {
		delete process.env.OMP_CONSOLE_SUPERVISED;
		const stateDir = makeTmp("config-write-state-");
		const configFile = writeConfig(stateDir, { features: { agenda: false } });
		const daemon = await startTestDaemon({ stateDir });
		const before = fs.readFileSync(configFile, "utf8");

		const invalid = await daemon.put("/api/config", { unknown: true });
		expect(invalid.status).toBe(400);
		expect(fs.readFileSync(configFile, "utf8")).toBe(before);

		const tooLarge = await daemon.put("/api/config", { comment: "x".repeat(65_536) });
		expect(tooLarge.status).toBe(413);
		expect(fs.readFileSync(configFile, "utf8")).toBe(before);

		const knowledgeRoot = path.join(stateDir, "knowledge");
		const projectRoot = path.join(stateDir, "project");
		const agendaHub = path.join(stateDir, "tasks-hub");
		fs.mkdirSync(knowledgeRoot);
		fs.mkdirSync(projectRoot);
		fs.mkdirSync(agendaHub);
		const saved: DaemonConfigFile = {
			features: { librarian: false, agenda: true, quickAsk: false, peers: false, openrouterDecisions: false, computerUse: false },
			knowledgeRoot,
			projectRoots: [projectRoot],
			agendaHub,
			quickAsk: { sources: ["repo"] },
		};
		const written = await daemon.put("/api/config", saved);
		expect(written.status).toBe(200);
		expect(await written.json()).toEqual({ restartRequired: true });
		expect(fs.statSync(configFile).mode & 0o777).toBe(0o600);
		expect(await loadDaemonConfigFile(stateDir)).toEqual(saved);

		await daemon.daemon.stop();
		const loaded = await loadDaemonConfigFile(stateDir);
		const restarted = await startDaemon({
			port: 0,
			stateDir,
			workerCmd: fakeCmd(),
			listRecent: async () => [],
			systemTrashDir: null,
			areaTimers: false,
			features: emptyFeatures({ agenda: loaded.features?.agenda === true }),
			knowledgeRoot: loaded.knowledgeRoot,
			projectRoots: loaded.projectRoots,
			quickAskSources: loaded.quickAsk?.sources,
			agendaHub: loaded.agendaHub === undefined ? undefined : { python: path.join(loaded.agendaHub, ".venv", "bin", "python"), cwd: loaded.agendaHub, env: {} },
			agentDir: daemon.agentDir,
			workerEnv: { PI_CONFIG_DIR: makeTmp("config-reload-pi-config-"), PI_CODING_AGENT_DIR: daemon.agentDir },
			onPairingCode: () => {},
		});
		restartedDaemons.push(restarted);
		const capabilities = await fetch(`${restarted.url}/api/capabilities`, { headers: { Cookie: daemon.cookie } });
		expect((await capabilities.json() as { features: { agenda: boolean } }).features.agenda).toBe(true);
	});

	it("rejects a config the next start would refuse, and reports requirements from the saved file", async () => {
		delete process.env.OMP_CONSOLE_SUPERVISED;
		const stateDir = makeTmp("config-start-check-state-");
		const configFile = writeConfig(stateDir, { features: { librarian: false } });
		const daemon = await startTestDaemon({ stateDir });
		const before = fs.readFileSync(configFile, "utf8");
		const goodToken = path.join(stateDir, "good-token");
		fs.writeFileSync(goodToken, Buffer.alloc(32, 3).toString("base64url"), { mode: 0o600 });
		const looseToken = path.join(stateDir, "loose-token");
		fs.writeFileSync(looseToken, Buffer.alloc(32, 3).toString("base64url"), { mode: 0o644 });
		const notToken = path.join(stateDir, "not-token");
		fs.writeFileSync(notToken, "hello", { mode: 0o600 });
		const peer = (tokenFile: string | undefined, id = "studio") => ({ id, name: "Studio", url: "https://peer.example", ...(tokenFile ? { tokenFile } : {}) });

		for (const body of [
			{ peers: [peer(goodToken, "local")] },
			{ peers: [peer(goodToken), peer(goodToken)] },
			{ features: { peers: true }, peers: [peer(path.join(stateDir, "missing"))] },
			{ features: { peers: true }, peers: [peer(looseToken)] },
			{ features: { peers: true }, peers: [peer(notToken)] },
		]) {
			const response = await daemon.put("/api/config", body);
			expect(response.status).toBe(400);
			expect(fs.readFileSync(configFile, "utf8")).toBe(before);
		}
		// Peers off: token files are not read at start, so an unusable one does not block saving.
		expect((await daemon.put("/api/config", { features: { peers: false }, peers: [peer(notToken)] })).status).toBe(200);

		const knowledgeRoot = makeTmp("config-start-check-knowledge-");
		const projectRoot = makeTmp("config-start-check-project-");
		const saved = await daemon.put("/api/config", {
			features: { librarian: true, quickAsk: true, openrouterDecisions: true },
			knowledgeRoot,
			projectRoots: [projectRoot],
			quickAsk: { sources: ["repo"] },
		});
		expect(saved.status).toBe(200);
		const config = await (await daemon.get("/api/config")).json() as DaemonConfigResponse;
		expect(config.features.librarian).toMatchObject({ configured: true, effective: false, missing: [] });
		expect(config.features.quickAsk).toMatchObject({ configured: true, effective: false, missing: [] });
		expect(config.features.openrouterDecisions.missing).toEqual([]);
	});

	it("refuses an unsupervised restart and reports busy sessions before an allowed forced restart", async () => {
		delete process.env.OMP_CONSOLE_SUPERVISED;
		let unsupervisedRestartCalls = 0;
		const unsupervised = await startTestDaemon({ requestRestart: () => unsupervisedRestartCalls++ });
		const refused = await unsupervised.post("/api/daemon/restart", {});
		expect(refused.status).toBe(409);
		expect(await refused.json()).toMatchObject({ error: "restart the daemon manually", code: "conflict" });
		expect(unsupervisedRestartCalls).toBe(0);

		process.env.OMP_CONSOLE_SUPERVISED = "1";
		let supervisedRestartCalls = 0;
		const script = JSON.stringify([{ at: 10, emit: { t: "state", state: "streaming", awaitingAnswer: false, goalActive: false, agentCount: 1, lastEventAt: "now" } }]);
		const supervised: TestDaemon = await startTestDaemon({
			workerFlags: ["--script", script],
			requestRestart: () => supervisedRestartCalls++,
		});
		const created = await supervised.post("/api/sessions", { cwd: supervised.dir, title: "Settings restart check" });
		expect(created.status).toBe(201);
		const session = await created.json() as { id: string };
		await until(() => supervised.daemon.supervisor.get(session.id)?.state === "streaming", "test session starts streaming");

		const busy = await supervised.post("/api/daemon/restart", {});
		expect(busy.status).toBe(409);
		expect(await busy.json()).toMatchObject({
			code: "conflict",
			busySessions: [{ id: session.id, title: "Settings restart check", cwd: supervised.dir }],
		} satisfies Partial<DaemonRestartConflict>);
		expect(supervisedRestartCalls).toBe(0);

		const forced = await supervised.post("/api/daemon/restart", { force: true });
		expect(forced.status).toBe(202);
		expect(await forced.json()).toEqual({ restarting: true });
		await until(() => supervisedRestartCalls === 1, "supervised restart requested");
	});
});
