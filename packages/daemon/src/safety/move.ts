import type {
	CreateSessionRequest,
	HistoryEdge,
	KeyPoints,
	MoveConfirmRequest,
	MoveDetail,
	MovePreview,
	MoveRecord,
	MovePrepareRequest,
} from "@omp-console/protocol";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isWindows } from "../platform";
import { DriftTracker } from "./drift";
import {
	assertNoSymlinkPath,
	isEnoent,
	isInside,
	MAX_MOVE_BYTES,
	MAX_MOVE_FILES,
	scanMoveFiles,
	snapshotPaths,
	type CopyFile,
} from "./files";
import type { SafetyPorts } from "./ports";

const PREVIEW_TTL_MS = 5 * 60 * 1000;
const SAFETY_DIR = "safety";
const MOVES_FILE = "moves.json";
const GENERATED_GITIGNORE = [
	"node_modules/",
	".venv/",
	"target/",
	"dist/",
	".env*",
	"*.pem",
	"id_*",
	"*credentials*",
	"*.key",
];
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

interface StoredCopyFile {
	path: string;
	size: number;
	dev: string;
	ino: string;
	mode: number;
	mtimeMs: number;
}

interface FileHash {
	path: string;
	sha256: string;
}

interface StoredMove {
	record: MoveRecord;
	suggestionId: string;
	nonce: string;
	expiresAt: number;
	files: StoredCopyFile[];
	bytes: number;
	excluded: MovePreview["excluded"];
	manifest?: FileHash[];
	finalDev?: string;
	finalIno?: string;
	hadEmptyDestination?: boolean;
}

interface MoveState {
	moves: StoredMove[];
}

export interface MoveServiceOptions {
	projectsRoot: string;
	trashDir?: string;
	/** Raw 32-byte Ed25519 public key of the Mac app's confirmation key, or null when the app never created one. */
	keyReader?: MoveKeyReader;
	now?: () => number;
	randomId?: () => string;
	beforeCopyFile?: (source: string, relativePath: string) => Promise<void>;
	hasCommits?: (root: string) => Promise<boolean>;
}

export type MoveKeyReader = () => Promise<Uint8Array | null>;

export class MoveError extends Error {
	constructor(message: string, readonly code: "bad-request" | "not-found" | "conflict" | "forbidden" | "internal") {
		super(message);
		this.name = "MoveError";
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBodyId(raw: string): string {
	if (!/^[A-Za-z0-9_-]{1,128}$/.test(raw)) throw new MoveError("invalid move id", "bad-request");
	return raw;
}

function validSlug(slug: string): boolean {
	return slug.length > 0 && slug.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}

function serializeFile(file: CopyFile): StoredCopyFile {
	return { path: file.path, size: file.size, dev: file.dev.toString(), ino: file.ino.toString(), mode: file.mode, mtimeMs: file.mtimeMs };
}

function deserializeFile(file: StoredCopyFile): CopyFile {
	return { ...file, dev: BigInt(file.dev), ino: BigInt(file.ino) };
}

function sameFiles(left: CopyFile[], right: StoredCopyFile[]): boolean {
	return left.length === right.length && left.every((file, index) => {
		const old = right[index];
		return old !== undefined && file.path === old.path && file.size === old.size && file.dev.toString() === old.dev &&
			file.ino.toString() === old.ino && file.mode === old.mode && file.mtimeMs === old.mtimeMs;
	});
}

function base64UrlEncode(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}

function base64UrlDecode(value: string): Uint8Array | undefined {
	if (!BASE64URL_RE.test(value)) return undefined;
	const bytes = Buffer.from(value, "base64url");
	if (base64UrlEncode(bytes) !== value) return undefined;
	return new Uint8Array(bytes);
}

/**
 * The Mac app keeps the Ed25519 signing key in its own Keychain item and writes only the public key here, so the
 * daemon never holds anything that can sign a confirmation.
 */
export const DEFAULT_MOVE_PUBLIC_KEY_FILE = path.join(os.homedir(), "Library", "Application Support", "dev.ompconsole.app", "move-public-key");

export async function readMovePublicKeyFile(
	filePath = DEFAULT_MOVE_PUBLIC_KEY_FILE,
	daemonUid = process.getuid?.(),
): Promise<Uint8Array | null> {
	if (isWindows) return null;
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(filePath, "r");
	} catch (error) {
		if (isEnoent(error)) return null;
		throw new MoveError("could not open move public key file", "forbidden");
	}
	try {
		const stat = await handle.stat();
		if (daemonUid === undefined || stat.uid !== daemonUid || (stat.mode & 0o022) !== 0) {
			throw new MoveError("move public key file must be owned by the daemon user and not be group/world-writable", "forbidden");
		}
		const key = base64UrlDecode((await handle.readFile("utf8")).trim());
		return key?.byteLength === 32 ? key : null;
	} catch (error) {
		if (error instanceof MoveError) throw error;
		throw new MoveError("could not read move public key file", "forbidden");
	} finally {
		await handle.close();
	}
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}

async function verifyEd25519(publicKey: Uint8Array, message: string, token: string): Promise<boolean> {
	const signature = base64UrlDecode(token);
	if (!signature || signature.byteLength !== 64 || publicKey.byteLength !== 32) return false;
	try {
		const key = await crypto.subtle.importKey("raw", toArrayBuffer(publicKey), { name: "Ed25519" }, false, ["verify"]);
		return await crypto.subtle.verify({ name: "Ed25519" }, key, toArrayBuffer(signature), toArrayBuffer(new TextEncoder().encode(message)));
	} catch {
		return false;
	}
}

/** What the source session hands over: omp's handoff document, or the librarian's key points when that failed. */
type MoveContext = { document: string } | { points: KeyPoints };

/** Largest handoff document carried into the new session's first message (the create route caps handoffs at 64 KB). */
const HANDOFF_DOCUMENT_LIMIT = 60 * 1024;

/**
 * The focus omp's handoff is written with. The document is the next session's whole context, so it has to name the
 * work in progress and the next step, not just summarise.
 */
function moveHandoffFocus(move: { sourceRoot: string; destination: string }): string {
	return [
		`The work continues right away in a new session inside a copy of this project at ${move.destination} (copied from ${move.sourceRoot}; the original stays as it is).`,
		"Write the handoff for that session: the task in progress and the user's latest request about it, what is already done and verified, decisions and constraints the user gave, and the exact next step.",
		"Describe the work, not this handoff request. Give file paths relative to the project root.",
	].join(" ");
}

/**
 * First message of the session that starts in the copy. It says what deck did (so the agent does not go looking),
 * carries the source session's handoff, and has the agent carry on with the work there. Only a source session with
 * no conversation yet leaves the agent waiting for the user.
 */
function renderHandoff(
	context: MoveContext,
	move: { sourceRoot: string; destination: string; files: number; excluded: number },
): string {
	const lines = [
		`omp console moved this project: it copied ${move.files} files from ${move.sourceRoot} into this new repository (${move.destination}), left out ${move.excluded} item(s) (dependencies, secrets, special files), and ran git init. The original folder is unchanged and is no longer this work's home: read and edit files here, where paths under ${move.sourceRoot} now live under ${move.destination}.`,
	];
	let empty = false;
	if ("document" in context) {
		const document =
			context.document.length > HANDOFF_DOCUMENT_LIMIT
				? `${context.document.slice(0, HANDOFF_DOCUMENT_LIMIT)}\n[handoff truncated]`
				: context.document;
		lines.push("Handoff from the session where this work started:", "<handoff>", document, "</handoff>");
	} else {
		const points = context.points;
		empty = !points.goal && !points.decisions.length && !points.outcome;
		lines.push(
			`Context from the session where the project started (${points.title}):`,
			...(points.goal ? [`Goal: ${points.goal}`] : []),
			...(points.decisions.length ? ["Decisions:", ...points.decisions.map(item => `- ${item}`)] : []),
			...(points.files.length ? ["Relevant files:", ...points.files.map(item => `- ${item}`)] : []),
			...(points.outcome ? [`Outcome: ${points.outcome}`] : []),
			...(points.openQuestions.length ? ["Open questions:", ...points.openQuestions.map(item => `- ${item}`)] : []),
			...(empty ? ["(That session had no conversation yet.)"] : []),
		);
	}
	lines.push(
		empty
			? "Reply with one short line confirming you are in the new project, then wait for the user's next message."
			: "Continue that work here now, from its next step, within the constraints above. Stop and ask instead only if the handoff says the work is finished or is waiting on the user (a question, an approval, a choice).",
	);
	return lines.join("\n");
}

function isStoredMove(value: unknown): value is StoredMove {
	if (!isObject(value) || !isObject(value.record)) return false;
	const record = value.record;
	return typeof record.id === "string" && typeof record.sourceSessionId === "string" && typeof record.sourceRoot === "string" &&
		typeof record.destination === "string" && typeof record.at === "number" &&
		(record.state === "prepared" || record.state === "done" || record.state === "undone" || record.state === "failed") &&
		typeof value.suggestionId === "string" && typeof value.nonce === "string" && typeof value.expiresAt === "number" &&
		Array.isArray(value.files) && typeof value.bytes === "number" && Array.isArray(value.excluded);
}

async function hasGitCommits(root: string): Promise<boolean> {
	const repository = vcs.git(root);
	if (!repository) throw new MoveError("destination is not a Git repository", "internal");
	const head = await repository.headSha();
	return typeof head === "string" && head.length > 0;
}

async function hashFile(file: string): Promise<string> {
	await assertNoSymlinkPath(file);
	const beforePath = await fs.lstat(file, { bigint: true });
	if (beforePath.isSymbolicLink() || !beforePath.isFile()) throw new MoveError("destination contains a special file", "conflict");
	const handle = await fs.open(file, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW);
	try {
		const before = await handle.stat({ bigint: true });
		if (
			!before.isFile() ||
			before.nlink > 1n ||
			before.dev !== beforePath.dev ||
			before.ino !== beforePath.ino
		) {
			throw new MoveError("destination contains a special or replaced file", "conflict");
		}
		const hasher = new Bun.CryptoHasher("sha256");
		const buffer = Buffer.allocUnsafe(64 * 1024);
		let position = 0;
		for (;;) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
			if (bytesRead === 0) break;
			hasher.update(buffer.subarray(0, bytesRead));
			position += bytesRead;
		}
		const after = await handle.stat({ bigint: true });
		const afterPath = await fs.lstat(file, { bigint: true });
		await assertNoSymlinkPath(file);
		if (
			afterPath.isSymbolicLink() ||
			after.dev !== before.dev ||
			after.ino !== before.ino ||
			after.size !== before.size ||
			after.mtimeMs !== before.mtimeMs ||
			afterPath.dev !== after.dev ||
			afterPath.ino !== after.ino
		) {
			throw new MoveError("destination changed while checking its manifest", "conflict");
		}
		return hasher.digest("hex");
	} finally {
		await handle.close();
	}
}

function addExpectedParents(target: Set<string>, relative: string): void {
	let current = path.posix.dirname(relative);
	while (current !== ".") {
		target.add(current);
		current = path.posix.dirname(current);
	}
}

async function readPathState(root: string): Promise<Set<string>> {
	return snapshotPaths(root, { includeDependencyDirs: true });
}

async function inspectEmptyDestination(destination: string): Promise<boolean> {
	try {
		const stat = await fs.lstat(destination);
		if (stat.isSymbolicLink() || !stat.isDirectory()) throw new MoveError("destination exists and is not a directory", "conflict");
		if ((await fs.readdir(destination)).length > 0) throw new MoveError("destination directory is not empty", "conflict");
		return true;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

export class MoveService {
	readonly #ports: SafetyPorts;
	readonly #drift: DriftTracker;
	readonly #stateFile: string;
	readonly #projectsRoot: string;
	readonly #trashDir: string;
	readonly #keyReader: MoveKeyReader;
	readonly #now: () => number;
	readonly #randomId: () => string;
	readonly #beforeCopyFile: ((source: string, relativePath: string) => Promise<void>) | undefined;
	readonly #hasCommits: (root: string) => Promise<boolean>;
	readonly #moves = new Map<string, StoredMove>();
	#loaded: Promise<void> | undefined;
	#writeQueue: Promise<void> = Promise.resolve();
	#lockQueue: Promise<unknown> = Promise.resolve();

	constructor(ports: SafetyPorts, drift: DriftTracker, stateDir: string, options: MoveServiceOptions) {
		this.#ports = ports;
		this.#drift = drift;
		this.#stateFile = path.join(stateDir, SAFETY_DIR, MOVES_FILE);
		this.#projectsRoot = path.resolve(options.projectsRoot);
		this.#trashDir = path.resolve(options.trashDir ?? path.join(os.homedir(), ".Trash"));
		this.#keyReader = options.keyReader ?? readMovePublicKeyFile;
		this.#now = options.now ?? (() => Date.now());
		this.#randomId = options.randomId ?? (() => crypto.randomUUID());
		this.#beforeCopyFile = options.beforeCopyFile;
		this.#hasCommits = options.hasCommits ?? hasGitCommits;
	}

	async prepare(request: MovePrepareRequest): Promise<MovePreview> {
		await this.#load();
		if (!validSlug(request.slug)) throw new MoveError("slug must use lowercase ASCII letters, digits and single hyphens, up to 64 characters", "bad-request");
		const suggestion = this.#drift.findSuggestion(request.suggestionId);
		if (!suggestion) throw new MoveError("drift suggestion not found", "not-found");
		const sourceRoot = path.resolve(suggestion.sourceRoot);
		const projectsRoot = this.#projectsRoot;
		await assertNoSymlinkPath(projectsRoot);
		await assertNoSymlinkPath(sourceRoot);
		const sourceStat = await fs.lstat(sourceRoot);
		if (!sourceStat.isDirectory()) throw new MoveError("source root must be a directory", "bad-request");
		if (isInside(sourceRoot, projectsRoot) || isInside(projectsRoot, sourceRoot)) {
			throw new MoveError("source and projects root must not contain one another", "bad-request");
		}
		const destination = path.join(projectsRoot, request.slug);
		await assertNoSymlinkPath(destination, true);
		await inspectEmptyDestination(destination);
		const scan = await scanMoveFiles(sourceRoot);
		if (scan.files.length > MAX_MOVE_FILES || scan.bytes > MAX_MOVE_BYTES) {
			throw new MoveError("source exceeds move limits", "bad-request");
		}
		const files = scan.files.map(serializeFile);
		const existing = [...this.#moves.values()].find(move => move.record.sourceSessionId === suggestion.sessionId &&
			move.record.sourceRoot === sourceRoot && move.record.destination === destination && move.record.state === "prepared");
		if (existing) {
			// Reuse only a preview that is still valid and still describes the tree; otherwise it is superseded, so an
			// expired or stale preview can never block the move.
			if (existing.expiresAt > this.#now() && JSON.stringify(existing.files) === JSON.stringify(files)) return this.#preview(existing);
			existing.record.state = "failed";
			existing.record.error = "superseded by a newer preview";
		}
		const id = parseBodyId(this.#randomId());
		if (this.#moves.has(id)) throw new MoveError("move id collision", "internal");
		const now = this.#now();
		const move: StoredMove = {
			record: {
				id,
				sourceSessionId: suggestion.sessionId,
				sourceRoot,
				destination,
				at: now,
				state: "prepared",
			},
			suggestionId: suggestion.id,
			nonce: this.#randomId(),
			expiresAt: now + PREVIEW_TTL_MS,
			files,
			bytes: scan.bytes,
			excluded: scan.excluded,
		};
		this.#moves.set(id, move);
		await this.#save();
		return this.#preview(move);
	}

	/** What the Mac app shows in its native dialog: daemon facts about one move, the nonce only while it can be confirmed. */
	async detail(moveId: string): Promise<MoveDetail> {
		const move = await this.#getMove(parseBodyId(moveId));
		const confirmable = move.record.state === "prepared" && move.expiresAt > this.#now();
		return {
			id: move.record.id,
			state: move.record.state,
			sourceRoot: move.record.sourceRoot,
			destination: move.record.destination,
			files: move.files.length,
			bytes: move.bytes,
			excluded: move.excluded,
			expiresAt: move.expiresAt,
			...(confirmable ? { nonce: move.nonce } : {}),
		};
	}

	async confirm(moveId: string, request: MoveConfirmRequest): Promise<MoveRecord> {
		const id = parseBodyId(moveId);
		const move = await this.#getMove(id);
		if (request.nonce !== move.nonce || !await this.#verify(move, request.token)) {
			throw new MoveError("native move confirmation is required", "forbidden");
		}
		if (move.record.state === "undone") return { ...move.record };
		return this.#withLock(async () => {
			const current = await this.#getMove(id);
			if (current.record.state === "done") {
				await this.#complete(current);
				return { ...current.record };
			}
			if (current.record.state === "undone") return { ...current.record };
			if (current.record.state !== "prepared") throw new MoveError("move is not prepared", "conflict");
			if (current.expiresAt <= this.#now()) throw new MoveError("move preview expired", "conflict");
			return this.#execute(current);
		});
	}

	async undo(moveId: string): Promise<void> {
		const id = parseBodyId(moveId);
		await this.#withLock(async () => {
			const move = await this.#getMove(id);
			if (move.record.state === "undone") return;
			if (move.record.state !== "done" || !move.manifest || !move.record.newSessionId) {
				throw new MoveError("only a completed move can be undone", "conflict");
			}
			await assertNoSymlinkPath(move.record.destination);
			if (await this.#hasCommits(move.record.destination)) throw new MoveError("move cannot be undone after a commit", "conflict");
			const currentPaths = await readPathState(move.record.destination);
			const expected = new Set<string>([".git"]);
			for (const item of move.manifest) {
				expected.add(item.path);
				addExpectedParents(expected, item.path);
				const actual = await hashFile(path.join(move.record.destination, item.path));
				if (actual !== item.sha256) throw new MoveError(`move copy changed: ${item.path}`, "conflict");
			}
			if (currentPaths.size !== expected.size || [...currentPaths].some(item => !expected.has(item))) {
				throw new MoveError("move copy has new or missing files", "conflict");
			}
			// The copy's own session must not keep running in a folder that is about to go to the Trash.
			await this.#ports.stopSession(move.record.newSessionId);
			await assertNoSymlinkPath(this.#trashDir, true);
			await fs.mkdir(this.#trashDir, { recursive: true, mode: 0o700 });
			const trashPath = await this.#uniqueTrashPath(move.record.destination, id);
			await fs.rename(move.record.destination, trashPath);
			try {
				await this.#ports.freezeSession(move.record.sourceSessionId, false);
			} catch (error) {
				await fs.rename(trashPath, move.record.destination).catch(() => {});
				throw error;
			}
			move.record.state = "undone";
			move.record.trashPath = trashPath;
			await this.#save();
		});
	}

	async list(): Promise<MoveRecord[]> {
		await this.#load();
		return [...this.#moves.values()].sort((left, right) => left.record.at - right.record.at).map(move => ({ ...move.record }));
	}

	async #execute(move: StoredMove): Promise<MoveRecord> {
		const sourceCwd = this.#ports.sessionCwd(move.record.sourceSessionId);
		if (!sourceCwd || !isInside(path.resolve(sourceCwd), move.record.sourceRoot)) {
			throw new MoveError("source session is no longer available at the suggested root", "conflict");
		}
		const currentScan = await scanMoveFiles(move.record.sourceRoot);
		if (!sameFiles(currentScan.files, move.files)) throw new MoveError("source changed after the move preview", "conflict");
		const destinationWasEmpty = await inspectEmptyDestination(move.record.destination);
		let staging: string | undefined;
		let destinationCreated = false;
		let sessionCreated = false;
		let lockHandle: fs.FileHandle | undefined;
		let lockPath: string | undefined;
		let destinationDev: bigint | undefined;
		let destinationIno: bigint | undefined;
		let frozen = false;
		try {
			await this.#ports.abortSession(move.record.sourceSessionId);
			frozen = true;
			await this.#ports.freezeSession(move.record.sourceSessionId, true);
			const projectsRoot = this.#projectsRoot;
			lockPath = path.join(projectsRoot, `.omp-console-move-${move.record.id}.lock`);
			lockHandle = await fs.open(lockPath, "wx", 0o600);
			const stagingPath = path.join(projectsRoot, `.omp-console-staging-${move.record.id}`);
			await fs.mkdir(stagingPath, { mode: 0o700 });
			staging = stagingPath;
			const manifest: FileHash[] = [];
			for (const file of move.files.map(deserializeFile)) {
				await this.#beforeCopyFile?.(path.join(move.record.sourceRoot, file.path), file.path);
				const source = path.join(move.record.sourceRoot, file.path);
				await assertNoSymlinkPath(source);
				const sourceHandle = await fs.open(source, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW);
				try {
					const before = await sourceHandle.stat({ bigint: true });
					const pathStat = await fs.lstat(source, { bigint: true });
					await assertNoSymlinkPath(source);
					if (
						!before.isFile() ||
						pathStat.isSymbolicLink() ||
						before.dev !== file.dev ||
						before.ino !== file.ino ||
						before.nlink > 1n ||
						before.size !== BigInt(file.size) ||
						Number(before.mtimeMs) !== file.mtimeMs
					) {
						throw new MoveError(`source changed while copying: ${file.path}`, "conflict");
					}
					const target = path.join(staging, file.path);
					await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
					await assertNoSymlinkPath(target, true);
					const targetHandle = await fs.open(
						target,
						fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL | fsSync.constants.O_NOFOLLOW,
						file.mode & 0o777,
					);
					const hasher = new Bun.CryptoHasher("sha256");
					const buffer = Buffer.allocUnsafe(64 * 1024);
					let position = 0;
					try {
						for (;;) {
							const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position);
							if (bytesRead === 0) break;
							const chunk = buffer.subarray(0, bytesRead);
							hasher.update(chunk);
							let written = 0;
							while (written < bytesRead) {
								const result = await targetHandle.write(chunk, written, bytesRead - written, position + written);
								if (result.bytesWritten === 0) throw new MoveError("destination write made no progress", "internal");
								written += result.bytesWritten;
							}
							position += bytesRead;
							if (position > MAX_MOVE_BYTES) throw new MoveError("source exceeds the 200 MB move limit", "bad-request");
						}
						const after = await sourceHandle.stat({ bigint: true });
						const afterPath = await fs.lstat(source, { bigint: true });
						await assertNoSymlinkPath(source);
						if (
							after.dev !== before.dev ||
							after.ino !== before.ino ||
							after.size !== before.size ||
							after.mtimeMs !== before.mtimeMs ||
							afterPath.isSymbolicLink()
						) {
							throw new MoveError(`source changed while copying: ${file.path}`, "conflict");
						}
						manifest.push({ path: file.path, sha256: hasher.digest("hex") });
					} finally {
						await targetHandle.close();
					}
				} finally {
					await sourceHandle.close();
				}
			}
			const ignorePath = path.join(staging, ".gitignore");
			let existingIgnore = "";
			try {
				existingIgnore = await Bun.file(ignorePath).text();
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
			const ignoreText = `${existingIgnore}${existingIgnore && !existingIgnore.endsWith("\n") ? "\n" : ""}${GENERATED_GITIGNORE.join("\n")}\n`;
			await fs.writeFile(ignorePath, ignoreText, { mode: 0o600 });
			manifest.push({ path: ".gitignore", sha256: await hashFile(ignorePath) });
			await this.#ports.initializeGit(staging);

			await assertNoSymlinkPath(move.record.destination, true);
			const stillEmpty = await inspectEmptyDestination(move.record.destination);
			move.hadEmptyDestination = stillEmpty;
			if (stillEmpty) await fs.rmdir(move.record.destination);
			await fs.rename(staging, move.record.destination);
			staging = undefined;
			destinationCreated = true;
			const destinationStat = await fs.stat(move.record.destination, { bigint: true });
			destinationDev = destinationStat.dev;
			destinationIno = destinationStat.ino;
			move.manifest = manifest;
			move.finalDev = destinationDev.toString();
			move.finalIno = destinationIno.toString();
			// The new session exists before the source is compacted: a move that fails to start it (worker cap, bad
			// model) must leave the source session untouched.
			const model = this.#ports.sessionModel(move.record.sourceSessionId);
			const request: CreateSessionRequest & { idempotencyKey: string } = {
				cwd: move.record.destination,
				...(model === undefined ? {} : { model }),
				idempotencyKey: move.record.id,
			};
			const created = await this.#ports.createSession(request);
			sessionCreated = true;
			move.record.newSessionId = created.id;
			const handoff = renderHandoff(await this.#sourceContext(move), {
				sourceRoot: move.record.sourceRoot,
				destination: move.record.destination,
				files: move.files.length,
				excluded: move.excluded.length,
			});
			await this.#ports.sendPrompt(created.id, handoff);
			move.record.state = "done";
			await this.#save();
			await this.#complete(move);
			return { ...move.record };
		} catch (error) {
			if (staging) await fs.rm(staging, { recursive: true, force: true });
			if (destinationCreated && !sessionCreated && destinationDev !== undefined && destinationIno !== undefined) {
				const current = await fs.lstat(move.record.destination, { bigint: true }).catch(() => undefined);
				if (current && current.dev === destinationDev && current.ino === destinationIno) {
					await fs.rm(move.record.destination, { recursive: true, force: true });
					if (move.hadEmptyDestination) await fs.mkdir(move.record.destination, { mode: 0o700 }).catch(() => {});
				}
			}
			if (sessionCreated) {
				move.record.state = "done";
				move.record.error = "move completed but post-move recording failed";
			} else {
				move.record.state = "failed";
				move.record.error = error instanceof MoveError ? error.message : "move execution failed";
			}
			// Unfreeze first and independently: a failed state write must never leave the source session frozen, and
			// the caller sees the move's own error, not the bookkeeping one.
			if (frozen && !sessionCreated) {
				await this.#ports.freezeSession(move.record.sourceSessionId, false).catch(() => {});
			}
			await this.#save().catch(() => {});
			throw error;
		} finally {
			await lockHandle?.close();
			if (lockHandle && lockPath) await fs.rm(lockPath, { force: true });
		}
	}

	/**
	 * omp's handoff from the source session, which also compacts it: the old session is left holding its handoff
	 * instead of its full context, and the new session starts from the same document. It runs after the copy
	 * succeeded, so a failed move never compacts the source. A session with nothing to hand off, no model, or a
	 * failing model call falls back to the librarian's key points; the move itself never fails on this.
	 */
	async #sourceContext(move: StoredMove): Promise<MoveContext> {
		try {
			return { document: await this.#ports.handoffDocument(move.record.sourceSessionId, moveHandoffFocus(move.record)) };
		} catch {
			return { points: await this.#ports.keyPoints(move.record.sourceSessionId) };
		}
	}

	async #complete(move: StoredMove): Promise<void> {
		const newSessionId = move.record.newSessionId;
		if (!newSessionId) throw new MoveError("completed move has no destination session", "internal");
		const edge: HistoryEdge = { from: move.record.sourceSessionId, to: newSessionId, kind: "move" };
		await this.#ports.recordEdge(edge);
		await this.#drift.markMoved(move.record.sourceSessionId, move.record.sourceRoot);
		if (move.record.error) {
			delete move.record.error;
			await this.#save();
		}
	}
	#preview(move: StoredMove): MovePreview {
		return {
			id: move.record.id,
			destination: move.record.destination,
			files: move.files.length,
			bytes: move.bytes,
			excluded: move.excluded,
			nonce: move.nonce,
			expiresAt: move.expiresAt,
		};
	}

	async #verify(move: StoredMove, token: string): Promise<boolean> {
		const key = await this.#keyReader();
		return key !== null && await verifyEd25519(key, `${move.record.id}.${move.nonce}`, token);
	}

	async #getMove(id: string): Promise<StoredMove> {
		await this.#load();
		const move = this.#moves.get(id);
		if (!move) throw new MoveError("move not found", "not-found");
		return move;
	}

	async #load(): Promise<void> {
		if (!this.#loaded) this.#loaded = this.#readState();
		await this.#loaded;
	}

	async #readState(): Promise<void> {
		let text: string;
		try {
			text = await Bun.file(this.#stateFile).text();
		} catch (error) {
			if (isEnoent(error)) return;
			throw error;
		}
		const parsed = JSON.parse(text) as Partial<MoveState>;
		if (!Array.isArray(parsed.moves)) throw new MoveError("move state is corrupt", "internal");
		for (const move of parsed.moves) {
			if (!isStoredMove(move)) throw new MoveError("move state is corrupt", "internal");
			this.#moves.set(move.record.id, move);
		}
	}

	async #save(): Promise<void> {
		const previous = this.#writeQueue;
		const release = Promise.withResolvers<void>();
		this.#writeQueue = previous.then(() => release.promise);
		await previous;
		try {
			await fs.mkdir(path.dirname(this.#stateFile), { recursive: true, mode: 0o700 });
			const temporary = `${this.#stateFile}.${crypto.randomUUID()}.tmp`;
			await fs.writeFile(temporary, JSON.stringify({ moves: [...this.#moves.values()] } satisfies MoveState), {
				encoding: "utf8",
				mode: 0o600,
				flag: "wx",
			});
			await fs.rename(temporary, this.#stateFile);
		} finally {
			release.resolve();
		}
	}

	async #withLock<T>(callback: () => Promise<T>): Promise<T> {
		const previous = this.#lockQueue;
		const release = Promise.withResolvers<void>();
		this.#lockQueue = previous.then(() => release.promise);
		await previous;
		try {
			return await callback();
		} finally {
			release.resolve();
		}
	}

	async #uniqueTrashPath(destination: string, moveId: string): Promise<string> {
		const base = `${path.basename(destination)}-${this.#now()}`;
		let candidate = path.join(this.#trashDir, base);
		try {
			await fs.lstat(candidate);
			candidate = path.join(this.#trashDir, `${base}-${moveId}`);
			await fs.lstat(candidate);
			throw new MoveError("Trash destination already exists", "conflict");
		} catch (error) {
			if (isEnoent(error)) return candidate;
			throw error;
		}
	}
}

export function createMoveService(
	ports: SafetyPorts,
	drift: DriftTracker,
	stateDir: string,
	options: MoveServiceOptions,
): MoveService {
	return new MoveService(ports, drift, stateDir, options);
}
