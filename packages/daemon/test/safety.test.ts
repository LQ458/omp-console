import { afterEach, describe, expect, it } from "bun:test";
import type {
	CreateSessionRequest,
	HistoryEdge,
	KeyPoints,
	SessionSummary,
	WorkspaceKind,
} from "@omp-console/protocol";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readGateStatus } from "../src/safety/gate";
import { DriftTracker } from "../src/safety/drift";
import { MoveError, MoveService, readMovePublicKeyFile } from "../src/safety/move";
import type { SafetyPorts } from "../src/safety/ports";
import { createSafetyRoutes } from "../src/safety/routes";
import { MAX_MOVE_BYTES, MAX_MOVE_FILES, scanMoveFiles } from "../src/safety/files";

const roots: string[] = [];
const SESSION_ID = "session-1";
/** The Mac app's confirmation key in tests: the daemon side only ever sees `MOVE_KEY` (the raw public key). */
const MOVE_PAIR = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as unknown as CryptoKeyPair;
const MOVE_KEY = new Uint8Array(await crypto.subtle.exportKey("raw", MOVE_PAIR.publicKey));

function tempDir(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "deck-safety-"));
	roots.push(root);
	return fs.realpathSync(root);
}

function writeFile(root: string, relative: string, contents: string): void {
	const file = path.join(root, relative);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, contents);
}

function summary(id: string, cwd: string): SessionSummary {
	return {
		id,
		cwd,
		state: "idle",
		createdAt: 1,
		lastActivityAt: 1,
		agentCount: 0,
		goalActive: false,
		awaitingAnswer: false,
	};
}

class FakeSafetyPorts implements SafetyPorts {
	readonly sessions = new Map<string, { cwd: string; kind: WorkspaceKind }>();
	readonly frozen: Array<{ id: string; frozen: boolean }> = [];
	readonly aborted: string[] = [];
	readonly created: Array<CreateSessionRequest & { idempotencyKey: string }> = [];
	readonly prompts: Array<{ id: string; text: string }> = [];
	/** Set to make starting the new session fail (worker cap, bad model). */
	createFailure: Error | undefined;
	readonly createdByKey = new Map<string, SessionSummary>();
	readonly edges: HistoryEdge[] = [];
	edgeWriteFailures = 0;
	readonly stopped: string[] = [];
	/** What omp's handoff returns for the source session; an Error makes it fail, as for a session with no messages. */
	handoffResult: string | Error = new Error("Nothing to hand off (no messages yet)");
	readonly handoffs: Array<{ id: string; focus: string; createdBefore: number }> = [];
	readonly models = new Map<string, string>();

	addSession(id: string, cwd: string, kind: WorkspaceKind = "knowledge"): void {
		this.sessions.set(id, { cwd, kind });
	}

	sessionCwd(id: string): string | undefined {
		return this.sessions.get(id)?.cwd;
	}

	sessionWorkspaceKind(id: string): WorkspaceKind | undefined {
		return this.sessions.get(id)?.kind;
	}

	sessionModel(id: string): string | undefined {
		return this.models.get(id);
	}

	async handoffDocument(id: string, focus: string): Promise<string> {
		this.handoffs.push({ id, focus, createdBefore: this.created.length });
		if (this.handoffResult instanceof Error) throw this.handoffResult;
		return this.handoffResult;
	}

	async abortSession(id: string): Promise<void> {
		this.aborted.push(id);
	}

	async freezeSession(id: string, frozen: boolean): Promise<void> {
		this.frozen.push({ id, frozen });
	}

	async sendPrompt(id: string, text: string): Promise<void> {
		this.prompts.push({ id, text });
	}

	async createSession(request: CreateSessionRequest & { idempotencyKey: string }): Promise<SessionSummary> {
		if (this.createFailure) throw this.createFailure;
		const existing = this.createdByKey.get(request.idempotencyKey);
		if (existing) return existing;
		this.created.push(request);
		const created = summary(`new-${this.created.length}`, request.cwd);
		this.createdByKey.set(request.idempotencyKey, created);
		return created;
	}

	async keyPoints(id: string): Promise<KeyPoints> {
		return {
			sessionId: id,
			title: "Project work",
			goal: "Build the utility",
			decisions: ["Keep the source copy"],
			files: ["src/index.ts"],
			outcome: "Started",
			openQuestions: ["Which release target?"],
			generatedAt: 1,
		};
	}

	recordEdge(edge: HistoryEdge): void {
		if (!this.edges.some(item => item.from === edge.from && item.to === edge.to && item.kind === edge.kind)) {
			this.edges.push(edge);
		}
		if (this.edgeWriteFailures > 0) {
			this.edgeWriteFailures--;
			throw new Error("history write acknowledgement lost");
		}
	}

	async initializeGit(cwd: string): Promise<void> {
		fs.mkdirSync(path.join(cwd, ".git"));
	}

	async stopSession(id: string): Promise<void> {
		this.stopped.push(id);
	}
}

interface Fixture {
	workspace: string;
	sourceRoot: string;
	stateDir: string;
	projectsRoot: string;
	trashDir: string;
	ports: FakeSafetyPorts;
	drift: DriftTracker;
	moves: MoveService;
	suggestionId: string;
}

async function projectFixture(options: {
	sourceFiles?: Record<string, string>;
	moveOptions?: Partial<ConstructorParameters<typeof MoveService>[3]>;
} = {}): Promise<Fixture> {
	const workspace = tempDir();
	const stateDir = tempDir();
	const projectsRoot = tempDir();
	const trashDir = tempDir();
	const ports = new FakeSafetyPorts();
	ports.addSession(SESSION_ID, workspace);
	const drift = new DriftTracker(stateDir, { statusPorcelain: async () => "" });
	await drift.captureSessionBaseline(SESSION_ID, workspace);
	for (const [relative, contents] of Object.entries(options.sourceFiles ?? { "package.json": "{\"name\":\"tool\"}\n", "src/index.ts": "export const answer = 42;\n" })) {
		writeFile(path.join(workspace, "tool"), relative, contents);
	}
	const suggestion = await drift.detect(SESSION_ID, workspace, "knowledge");
	if (!suggestion) throw new Error("fixture did not trigger drift");
	const moves = new MoveService(ports, drift, stateDir, {
		projectsRoot,
		trashDir,
		keyReader: async () => MOVE_KEY,
		randomId: (() => {
			let count = 0;
			return () => `move-${++count}`;
		})(),
		hasCommits: async () => false,
		...options.moveOptions,
	});
	return { workspace, sourceRoot: suggestion.sourceRoot, stateDir, projectsRoot, trashDir, ports, drift, moves, suggestionId: suggestion.id };
}

async function signMoveToken(id: string, nonce: string): Promise<string> {
	const signature = await crypto.subtle.sign({ name: "Ed25519" }, MOVE_PAIR.privateKey, new TextEncoder().encode(`${id}.${nonce}`));
	return Buffer.from(new Uint8Array(signature)).toString("base64url");
}

async function routeRequest(
	routes: (req: Request, url: URL) => Promise<Response | undefined>,
	method: string,
	pathname: string,
	body?: unknown,
): Promise<Response> {
	const request = new Request(`http://localhost${pathname}`, {
		method,
		headers: body === undefined ? undefined : { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const response = await routes(request, new URL(request.url));
	if (!response) throw new Error(`route did not handle ${method} ${pathname}`);
	return response;
}

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("gate status", () => {
	it("reads the v0.6 layout without writing config: version from the extension, enforce flags, newest 200 audit lines first", async () => {
		const installDir = tempDir();
		const stateDir = tempDir();
		const extensionFile = path.join(tempDir(), "action-gate.ts");
		const configFile = path.join(tempDir(), "config.json");
		const auditFile = path.join(stateDir, "audit.jsonl");
		fs.writeFileSync(extensionFile, `export { default } from "${installDir}/agent-action-gate/0.6.2/src/adapters/omp.ts";\n`);
		fs.writeFileSync(configFile, JSON.stringify({ enforce: { interactive: true, subagent: false, scheduled: false } }));
		const configBefore = fs.readFileSync(configFile, "utf8");
		fs.writeFileSync(
			auditFile,
			Array.from({ length: 205 }, (_value, index) => JSON.stringify({
				ts: index,
				context: "interactive",
				verdict: "allow",
				reason: index === 204 ? "shadow: would deny (gate.self)" : index === 203 ? "shadow: would ask (shell.unknown-effect)" : "read action",
				kinds: index >= 203 ? ["gate.self"] : [],
				session: "eed2e945b2c2",
			})).join("\n"),
		);

		const status = await readGateStatus({ installDir, extensionFile, configPath: () => configFile, stateDir, auditFile });
		expect(status).toMatchObject({
			installed: true,
			version: "0.6.2",
			modes: { interactive: "enforce", subagent: "shadow", scheduled: "shadow" },
			evidence: "shadow recommended: 2.31 prompts/message vs 2.25 rollout threshold",
		});
		expect(status.audit).toHaveLength(200);
		expect(status.audit[0]).toMatchObject({ at: 204, verdict: "would-deny", sessionId: "eed2e945b2c2" });
		expect(status.audit[1]).toMatchObject({ at: 203, verdict: "would-ask" });
		expect(status.audit[199]).toMatchObject({ at: 5, verdict: "allow", summary: "read action" });
		expect(fs.readFileSync(configFile, "utf8")).toBe(configBefore);
	});

	it("shows enforce everywhere when the gate is installed but its config is missing", async () => {
		const installDir = tempDir();
		const extensionFile = path.join(tempDir(), "action-gate.ts");
		fs.writeFileSync(extensionFile, `export { default } from "/x/agent-action-gate/0.6.2/src/adapters/omp.ts";\n`);
		const status = await readGateStatus({
			installDir,
			extensionFile,
			configPath: () => path.join(installDir, "missing.json"),
			stateDir: tempDir(),
		});
		expect(status.modes).toEqual({ interactive: "enforce", subagent: "enforce", scheduled: "enforce" });
	});
});

describe("project drift", () => {
	it("detects newly created marker roots only in knowledge sessions and a dismissal mutes that root", async () => {
		const workspace = tempDir();
		const stateDir = tempDir();
		const tracker = new DriftTracker(stateDir, { statusPorcelain: async () => "" });
		await tracker.captureSessionBaseline(SESSION_ID, workspace);
		writeFile(workspace, "tool/package.json", "{}\n");
		writeFile(workspace, "tool/src/main.ts", "export {};\n");
		for (let index = 0; index < 5; index++) writeFile(workspace, `tool/src/part-${index}.ts`, "export {};\n");
		writeFile(workspace, "other/Cargo.toml", "[package]\nname='other'\n");
		await tracker.captureSessionBaseline(SESSION_ID, workspace);

		expect(await tracker.detect(SESSION_ID, workspace, "project")).toBeNull();
		const first = await tracker.detect(SESSION_ID, workspace, "knowledge");
		expect(first).toMatchObject({
			sourceRoot: path.join(workspace, "other"),
			markers: ["Cargo.toml"],
			files: 1,
		});
		await tracker.dismiss(SESSION_ID, first!.id);
		const reopened = new DriftTracker(stateDir, { statusPorcelain: async () => "" });
		const next = await reopened.detect(SESSION_ID, workspace, "knowledge");
		expect(next).toMatchObject({
			sourceRoot: path.join(workspace, "tool"),
			markers: ["package.json", "src/"],
			files: 7,
		});
		await reopened.dismiss(SESSION_ID, next!.id);
		expect(await reopened.detect(SESSION_ID, workspace, "knowledge")).toBeNull();
	});

	it("includes newly created ignored filesystem paths in the baseline diff", async () => {
		const workspace = tempDir();
		const stateDir = tempDir();
		let status = "";
		const tracker = new DriftTracker(stateDir, { statusPorcelain: async () => status });
		await tracker.captureSessionBaseline(SESSION_ID, workspace);
		writeFile(workspace, "new-tool/package.json", "{}\n");
		status = "!! new-tool/package.json\0";
		const suggestion = await tracker.detect(SESSION_ID, workspace, "knowledge");
		expect(suggestion?.sourceRoot).toBe(path.join(workspace, "new-tool"));
	});
});

describe("safe move", () => {
	it("rejects invalid slugs, source symlink paths and occupied destinations", async () => {
		const fixture = await projectFixture();
		for (const slug of ["MyTool", "а-tool", "-rf", "", "a".repeat(65)]) {
			await expect(fixture.moves.prepare({ suggestionId: fixture.suggestionId, slug })).rejects.toMatchObject({ code: "bad-request" });
		}
		const link = path.join(path.dirname(fixture.sourceRoot), "source-link");
		fs.symlinkSync(fixture.sourceRoot, link);
		await expect(scanMoveFiles(link)).rejects.toThrow("symlink path component");
		fs.mkdirSync(path.join(fixture.projectsRoot, "tool"));
		writeFile(fixture.projectsRoot, "tool/existing.txt", "keep\n");
		await expect(fixture.moves.prepare({ suggestionId: fixture.suggestionId, slug: "tool" })).rejects.toMatchObject({ code: "conflict" });
		expect(fs.readFileSync(path.join(fixture.projectsRoot, "tool", "existing.txt"), "utf8")).toBe("keep\n");
	});

	it("excludes dependency directories, secrets, hardlinks and enforces both copy caps", async () => {
		const source = tempDir();
		writeFile(source, "package.json", "{}\n");
		writeFile(source, ".env.local", "secret\n");
		writeFile(source, "id_key", "secret\n");
		writeFile(source, "credentials.json", "secret\n");
		writeFile(source, "node_modules/pkg/index.js", "dependency\n");
		writeFile(source, "linked.txt", "hardlink\n");
		fs.linkSync(path.join(source, "linked.txt"), path.join(source, "second-link.txt"));
		const scan = await scanMoveFiles(source);
		expect(scan.files.map(file => file.path)).toContain("package.json");
		expect(scan.files.some(file => file.path.includes(".env") || file.path.includes("node_modules") || file.path.includes("linked"))).toBe(false);
		expect(scan.excluded).toEqual(expect.arrayContaining([
			{ path: ".env.local", reason: "secret" },
			{ path: "id_key", reason: "secret" },
			{ path: "credentials.json", reason: "secret" },
			{ path: "node_modules", reason: "dependency-dir" },
			{ path: "linked.txt", reason: "hardlink" },
			{ path: "second-link.txt", reason: "hardlink" },
		]));

		const large = tempDir();
		fs.writeFileSync(path.join(large, "oversized.bin"), "");
		fs.truncateSync(path.join(large, "oversized.bin"), MAX_MOVE_BYTES + 1);
		const largeScan = await scanMoveFiles(large);
		expect(largeScan.bytes).toBe(0);
		expect(largeScan.excluded).toContainEqual({ path: "oversized.bin", reason: "too-large" });

		const many = tempDir();
		for (let index = 0; index <= MAX_MOVE_FILES; index++) fs.writeFileSync(path.join(many, `file-${String(index).padStart(5, "0")}`), "");
		const manyScan = await scanMoveFiles(many);
		expect(manyScan.files).toHaveLength(MAX_MOVE_FILES);
		expect(manyScan.excluded).toHaveLength(1);
		expect(manyScan.excluded[0]?.reason).toBe("too-large");
	}, 30_000);

	it("requires the Mac app's Ed25519 signature, aborts and freezes before copying, and confirms idempotently", async () => {
		const fixture = await projectFixture({ sourceFiles: {
			"package.json": "{\"name\":\"tool\"}\n",
			"src/index.ts": "export const source = true;\n",
			".env.local": "do-not-copy\n",
			"node_modules/pkg/index.js": "ignored\n",
		} });
		const routes = createSafetyRoutes(fixture.ports, fixture.stateDir, {
			move: {
				projectsRoot: fixture.projectsRoot,
				trashDir: fixture.trashDir,
				keyReader: async () => MOVE_KEY,
				randomId: (() => {
					let count = 0;
					return () => `route-${++count}`;
				})(),
				hasCommits: async () => false,
			},
			drift: { statusPorcelain: async () => "" },
		});
		const driftResponse = await routeRequest(routes, "GET", `/api/sessions/${SESSION_ID}/drift`);
		const suggestion = (await driftResponse.json()) as { id: string };
		const preparedResponse = await routeRequest(routes, "POST", "/api/moves", { suggestionId: suggestion.id, slug: "tool" });
		const prepared = (await preparedResponse.json()) as { id: string; nonce: string; destination: string };
		const missingToken = await routeRequest(routes, "POST", `/api/moves/${prepared.id}/confirm`, { nonce: prepared.nonce });
		expect(missingToken.status).toBe(403);
		expect(fixture.ports.aborted).toEqual([]);
		expect(fs.existsSync(prepared.destination)).toBe(false);

		// The Mac app reads the daemon's own facts for its dialog; the nonce is only there while the move is confirmable.
		const detail = (await (await routeRequest(routes, "GET", `/api/moves/${prepared.id}`)).json()) as { state: string; nonce?: string; sourceRoot: string; excluded: unknown[] };
		expect(detail).toMatchObject({ state: "prepared", nonce: prepared.nonce, sourceRoot: fixture.sourceRoot });
		expect(detail.excluded.length).toBe(2);
		// A token in the old shared-secret format (32-byte HMAC) is refused.
		const hmacShaped = Buffer.alloc(32, 7).toString("base64url");
		expect((await routeRequest(routes, "POST", `/api/moves/${prepared.id}/confirm`, { nonce: prepared.nonce, token: hmacShaped })).status).toBe(403);
		const token = await signMoveToken(prepared.id, prepared.nonce);
		const confirmedResponse = await routeRequest(routes, "POST", `/api/moves/${prepared.id}/confirm`, { nonce: prepared.nonce, token });
		expect(confirmedResponse.status).toBe(200);
		const confirmed = (await confirmedResponse.json()) as { state: string; newSessionId: string };
		expect(confirmed).toMatchObject({ state: "done", newSessionId: "new-1" });
		expect(fixture.ports.aborted).toEqual([SESSION_ID]);
		expect(fixture.ports.frozen).toEqual([{ id: SESSION_ID, frozen: true }]);
		expect(fixture.ports.created[0]?.cwd).toBe(prepared.destination);
		expect(fixture.ports.prompts.map(prompt => prompt.id)).toEqual(["new-1"]);
		const handoff = fixture.ports.prompts[0]?.text ?? "";
		expect(handoff).toContain(`omp console moved this project: it copied 2 files from ${fixture.sourceRoot}`);
		// omp's handoff failed (the fake source has no messages), so the librarian's key points carry the context and
		// the agent continues instead of idling.
		expect(handoff).toContain("Context from the session where the project started (Project work):");
		expect(handoff).toContain("Continue that work here now");
		expect(handoff).not.toContain("wait for the user's next message");
		expect(fixture.ports.created[0]?.idempotencyKey).toBe(prepared.id);
		expect(fixture.ports.edges).toEqual([{ from: SESSION_ID, to: "new-1", kind: "move" }]);
		expect(fs.readFileSync(path.join(prepared.destination, "src/index.ts"), "utf8")).toBe("export const source = true;\n");
		expect(fs.existsSync(path.join(prepared.destination, ".env.local"))).toBe(false);
		expect(fs.existsSync(path.join(prepared.destination, "node_modules"))).toBe(false);
		expect(fs.readFileSync(path.join(fixture.sourceRoot, "src/index.ts"), "utf8")).toBe("export const source = true;\n");
		const repeated = await routeRequest(routes, "POST", `/api/moves/${prepared.id}/confirm`, { nonce: prepared.nonce, token });
		expect((await repeated.json() as { state: string }).state).toBe("done");
		expect(fixture.ports.created).toHaveLength(1);
		expect(fixture.ports.edges).toHaveLength(1);
		const after = (await (await routeRequest(routes, "GET", `/api/moves/${prepared.id}`)).json()) as { state: string; nonce?: string };
		expect(after.state).toBe("done");
		expect(after.nonce).toBeUndefined();
	});

	it("hands the source session's omp handoff to the new session, after the copy, with the source's model", async () => {
		const fixture = await projectFixture();
		fixture.ports.handoffResult = "## Goal\nShip the parser\n## Next step\nRun the failing test in src/index.ts";
		fixture.ports.models.set(SESSION_ID, "anthropic/claude-opus-5-5");
		const prepared = await fixture.moves.prepare({ suggestionId: fixture.suggestionId, slug: "tool" });
		const token = await signMoveToken(prepared.id, prepared.nonce);
		await fixture.moves.confirm(prepared.id, { nonce: prepared.nonce, token });

		expect(fixture.ports.handoffs).toHaveLength(1);
		const call = fixture.ports.handoffs[0]!;
		expect(call.id).toBe(SESSION_ID);
		expect(call.focus).toContain(prepared.destination);
		// The new session was started before omp's handoff compacted the source.
		expect(call.createdBefore).toBe(1);
		const request = fixture.ports.created[0]!;
		expect(request.model).toBe("anthropic/claude-opus-5-5");
		const first = fixture.ports.prompts[0]?.text ?? "";
		expect(first).toContain("<handoff>\n## Goal\nShip the parser\n## Next step\nRun the failing test in src/index.ts\n</handoff>");
		expect(first).toContain(`paths under ${fixture.sourceRoot} now live under ${prepared.destination}`);
		expect(first).toContain("Continue that work here now");
		expect(first).not.toContain("Context from the session where the project started");
	});

	it("leaves the source session uncompacted when the new session cannot start", async () => {
		const fixture = await projectFixture();
		fixture.ports.handoffResult = "## Goal\nX";
		fixture.ports.createFailure = new Error("worker cap reached");
		const prepared = await fixture.moves.prepare({ suggestionId: fixture.suggestionId, slug: "tool" });
		const token = await signMoveToken(prepared.id, prepared.nonce);
		await expect(fixture.moves.confirm(prepared.id, { nonce: prepared.nonce, token })).rejects.toThrow("worker cap reached");
		expect(fixture.ports.handoffs).toEqual([]);
		expect(fs.existsSync(path.join(fixture.projectsRoot, "tool"))).toBe(false);
		expect(fixture.ports.frozen.at(-1)).toEqual({ id: SESSION_ID, frozen: false });
	});

	it("tells the new session to wait only when the source session had no conversation", async () => {
		const fixture = await projectFixture();
		fixture.ports.keyPoints = async id => ({ sessionId: id, title: "tool", decisions: [], files: [], openQuestions: [], generatedAt: 1 });
		const prepared = await fixture.moves.prepare({ suggestionId: fixture.suggestionId, slug: "tool" });
		await fixture.moves.confirm(prepared.id, { nonce: prepared.nonce, token: await signMoveToken(prepared.id, prepared.nonce) });
		const handoff = fixture.ports.prompts[0]?.text ?? "";
		expect(handoff).toContain("(That session had no conversation yet.)");
		expect(handoff).toContain("then wait for the user's next message");
	});

	it("cleans staging and unfreezes when a source file becomes a symlink during copy", async () => {
		const fixture = await projectFixture({ moveOptions: {
			beforeCopyFile: async source => {
				const original = `${source}.original`;
				fs.renameSync(source, original);
				fs.symlinkSync(original, source);
			},
		} });
		const prepared = await fixture.moves.prepare({ suggestionId: fixture.suggestionId, slug: "tool" });
		const token = await signMoveToken(prepared.id, prepared.nonce);
		await expect(fixture.moves.confirm(prepared.id, { nonce: prepared.nonce, token })).rejects.toThrow();
		// A move that failed never compacted the source session.
		expect(fixture.ports.handoffs).toEqual([]);
		expect(fs.existsSync(path.join(fixture.projectsRoot, `.deck-staging-${prepared.id}`))).toBe(false);
		expect(fs.existsSync(path.join(fixture.projectsRoot, "tool"))).toBe(false);
		expect(fixture.ports.frozen.at(-1)).toEqual({ id: SESSION_ID, frozen: false });
	});

	it("prepares and confirms with the default id generator and clock (no injected randomId)", async () => {
		const fixture = await projectFixture({ moveOptions: { randomId: undefined, now: undefined } });
		const prepared = await fixture.moves.prepare({ suggestionId: fixture.suggestionId, slug: "tool" });
		expect(prepared.id).toMatch(/^[0-9a-f-]{36}$/);
		const token = await signMoveToken(prepared.id, prepared.nonce);
		await fixture.moves.confirm(prepared.id, { nonce: prepared.nonce, token });
		expect(fs.existsSync(path.join(fixture.projectsRoot, "tool", "package.json"))).toBe(true);
	});

	it("replaces an expired preview on re-prepare, so the move can still be confirmed", async () => {
		let now = 1_000_000;
		const fixture = await projectFixture({ moveOptions: { now: () => now } });
		const first = await fixture.moves.prepare({ suggestionId: fixture.suggestionId, slug: "tool" });
		now += 6 * 60_000;
		await expect(fixture.moves.confirm(first.id, { nonce: first.nonce, token: await signMoveToken(first.id, first.nonce) })).rejects.toThrow("expired");
		const second = await fixture.moves.prepare({ suggestionId: fixture.suggestionId, slug: "tool" });
		expect(second.id).not.toBe(first.id);
		await fixture.moves.confirm(second.id, { nonce: second.nonce, token: await signMoveToken(second.id, second.nonce) });
		expect(fs.existsSync(path.join(fixture.projectsRoot, "tool", "package.json"))).toBe(true);
	});

	it("replaces a preview whose source changed, so the new file list is the one copied", async () => {
		const fixture = await projectFixture();
		const first = await fixture.moves.prepare({ suggestionId: fixture.suggestionId, slug: "tool" });
		writeFile(fixture.sourceRoot, "src/new.ts", "export const fresh = true;\n");
		await expect(fixture.moves.confirm(first.id, { nonce: first.nonce, token: await signMoveToken(first.id, first.nonce) })).rejects.toThrow("changed");
		const second = await fixture.moves.prepare({ suggestionId: fixture.suggestionId, slug: "tool" });
		expect(second.id).not.toBe(first.id);
		expect(second.files).toBe(first.files + 1);
		await fixture.moves.confirm(second.id, { nonce: second.nonce, token: await signMoveToken(second.id, second.nonce) });
		expect(fs.existsSync(path.join(fixture.projectsRoot, "tool", "src", "new.ts"))).toBe(true);
	});

	it("refuses undo after an edit or a new file, then moves an unchanged copy to Trash", async () => {
		const fixture = await projectFixture();
		const prepared = await fixture.moves.prepare({ suggestionId: fixture.suggestionId, slug: "tool" });
		const token = await signMoveToken(prepared.id, prepared.nonce);
		await fixture.moves.confirm(prepared.id, { nonce: prepared.nonce, token });
		const copiedFile = path.join(prepared.destination, "src/index.ts");
		fs.writeFileSync(copiedFile, "edited\n");
		await expect(fixture.moves.undo(prepared.id)).rejects.toMatchObject({ code: "conflict" });
		fs.writeFileSync(copiedFile, "export const answer = 42;\n");
		writeFile(prepared.destination, "new-file.txt", "new\n");
		await expect(fixture.moves.undo(prepared.id)).rejects.toMatchObject({ code: "conflict" });
		// Refused undos leave the copy's session running.
		expect(fixture.ports.stopped).toEqual([]);
		fs.rmSync(path.join(prepared.destination, "new-file.txt"));
		await fixture.moves.undo(prepared.id);
		expect(fixture.ports.stopped).toEqual(["new-1"]);
		const trashed = fs.readdirSync(fixture.trashDir);
		expect(trashed).toHaveLength(1);
		expect(fs.existsSync(path.join(fixture.trashDir, trashed[0]!, "src/index.ts"))).toBe(true);
		expect(fixture.ports.frozen.at(-1)).toEqual({ id: SESSION_ID, frozen: false });
		expect((await fixture.moves.list())[0]?.state).toBe("undone");
	});

	it("returns 403 for an invalid confirmation and leaves source, session and destination untouched", async () => {
		const fixture = await projectFixture();
		const prepared = await fixture.moves.prepare({ suggestionId: fixture.suggestionId, slug: "tool" });
		await expect(fixture.moves.confirm(prepared.id, { nonce: prepared.nonce, token: "invalid" })).rejects.toMatchObject({ code: "forbidden" } satisfies Partial<MoveError>);
		expect(fixture.ports.aborted).toEqual([]);
		expect(fixture.ports.created).toEqual([]);
		expect(fs.existsSync(path.join(fixture.projectsRoot, "tool"))).toBe(false);
	});

	it("refuses undo after the moved copy gains a commit", async () => {
		const fixture = await projectFixture({ moveOptions: { hasCommits: async () => true } });
		const prepared = await fixture.moves.prepare({ suggestionId: fixture.suggestionId, slug: "tool" });
		const token = await signMoveToken(prepared.id, prepared.nonce);
		await fixture.moves.confirm(prepared.id, { nonce: prepared.nonce, token });
		await expect(fixture.moves.undo(prepared.id)).rejects.toMatchObject({ code: "conflict" });
		expect(fs.existsSync(prepared.destination)).toBe(true);
		expect(fixture.ports.frozen.at(-1)).toEqual({ id: SESSION_ID, frozen: true });
	});

	it("retries completion bookkeeping without creating a duplicate session or edge", async () => {
		const fixture = await projectFixture();
		const prepared = await fixture.moves.prepare({ suggestionId: fixture.suggestionId, slug: "tool" });
		const token = await signMoveToken(prepared.id, prepared.nonce);
		fixture.ports.edgeWriteFailures = 1;
		await expect(fixture.moves.confirm(prepared.id, { nonce: prepared.nonce, token })).rejects.toThrow(
			"history write acknowledgement lost",
		);
		expect((await fixture.moves.list())[0]).toMatchObject({ state: "done", error: "move completed but post-move recording failed" });
		const recovered = await fixture.moves.confirm(prepared.id, { nonce: prepared.nonce, token });
		expect(recovered).toMatchObject({ state: "done", newSessionId: "new-1" });
		expect(recovered.error).toBeUndefined();
		expect(fixture.ports.created).toHaveLength(1);
		expect(fixture.ports.edges).toEqual([{ from: SESSION_ID, to: "new-1", kind: "move" }]);
	});
	it("refuses move public keys that are writable by others or owned by another user", async () => {
		const keyFile = path.join(tempDir(), "public-key");
		fs.writeFileSync(keyFile, Buffer.from(MOVE_KEY).toString("base64url"), { mode: 0o600 });
		const daemonUid = process.getuid?.();
		if (daemonUid === undefined) throw new Error("test requires process uid support");
		expect(await readMovePublicKeyFile(keyFile, daemonUid)).toEqual(MOVE_KEY);

		for (const rejected of [
			{ mode: 0o620, uid: daemonUid },
			{ mode: 0o602, uid: daemonUid },
			{ mode: 0o600, uid: daemonUid + 1 },
		]) {
			fs.chmodSync(keyFile, rejected.mode);
			const fixture = await projectFixture({
				moveOptions: { keyReader: () => readMovePublicKeyFile(keyFile, rejected.uid) },
			});
			const prepared = await fixture.moves.prepare({ suggestionId: fixture.suggestionId, slug: "tool" });
			await expect(
				fixture.moves.confirm(prepared.id, {
					nonce: prepared.nonce,
					token: await signMoveToken(prepared.id, prepared.nonce),
				}),
			).rejects.toMatchObject({
				code: "forbidden",
				message: expect.stringContaining("move public key file"),
			});
		}
	});

});
