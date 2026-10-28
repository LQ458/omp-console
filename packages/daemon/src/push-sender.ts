/**
 * Web Push sender (RFC 8030 / 8291 / 8292) for the installed PWA.
 *
 * - VAPID key pair: generated on first run with `web-push`, stored as `vapid-keys.json` under the state dir
 *   (mode 0600), reused on every later start. It is never logged and never leaves the daemon except the public
 *   half through `GET /api/push/public-key`. A corrupt key file stops the daemon instead of being replaced,
 *   because a new key silently invalidates every stored subscription.
 * - Triggers: every worker `notify` status and every worker crash. Everything else stays silent.
 * - Payload: the session's list title (its card) plus a phrase per reason; a finished turn reads "<title> finished"
 *   with the first sentence of the agent's last reply as the body. Tool output and file contents
 *   are never put on the wire; the payload is encrypted to the device.
 * - Delivery: `Urgency: high`, `TTL` (default 3600 s), one POST per stored subscription in parallel. A failing,
 *   slow or hanging subscription never delays the others; there are no retries (a retry after a crash notification
 *   storm is worse than a missed one, and the next event sends again). 404 and 410 remove the subscription.
 * - Coalescing: at most one push per session and reason per `coalesceMs` (default 30 s); extra events in the window
 *   are dropped. The notification `tag` also makes the device replace instead of stack.
 *
 * The request is built with `web-push`'s `generateRequestDetails` (VAPID JWT, aes128gcm encryption) and sent with
 * fetch, so timeouts, cancellation on shutdown and the test seam are ours.
 */
import type { PendingUiRequest, PushPayload, PushReason } from "@omp-console/protocol";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import * as webpush from "web-push";
import type { PushStore, StoredPushSubscription } from "./push";
import { latestAnswerableChoices, type PushAnswerTokenStore } from "./push-answer";
import type { CrashEvent, NotifyEvent } from "./supervisor";

export const DEFAULT_PUSH_TTL_SECONDS = 3600;
export const DEFAULT_PUSH_COALESCE_MS = 30_000;
export const DEFAULT_PUSH_TIMEOUT_MS = 10_000;
export const DEFAULT_TURN_FINISHED_THRESHOLD_MS = 5 * 60 * 1000;
export const DEFAULT_PUSH_SUBJECT = "mailto:omp-console@example.invalid";

const VAPID_FILE = "vapid-keys.json";
const VAPID_PUBLIC_BYTES = 65;
const VAPID_PRIVATE_BYTES = 32;
const MAX_TITLE_CHARS = 80;
const FALLBACK_TITLE = "omp console session";
const MAX_UPDATE_CHARS = 120;
/** How long a push waits for the session's title and latest update before it goes out with what it has. */
const DESCRIBE_TIMEOUT_MS = 1_500;

const BODY_BY_REASON: Record<PushReason, string> = {
	"turn-finished": "Turn finished",
	"needs-answer": "Needs your answer",
	"needs-approval": "Needs your approval",
	"worker-crashed": "Session crashed",
	"overnight-complete": "Overnight run complete",
	"overnight-deadline": "Overnight run deadline reached",
	"overnight-blocked": "Overnight run blocked",
};

export type PushFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface PushSenderOptions {
	stateDir: string;
	store: PushStore;
	/** VAPID `sub` claim: a `mailto:` or `https:` contact. */
	subject?: string;
	ttlSeconds?: number;
	coalesceMs?: number;
	/** Per-request deadline. */
	timeoutMs?: number;
	/** Minimum turn duration before sending a completion push. */
	turnFinishedThresholdMs?: number;
	/** Test seam: the transport. Defaults to the global fetch. */
	fetch?: PushFetch;
	/** The shared, in-memory store backing one-use notification answer tokens. */
	answerTokens?: PushAnswerTokenStore;
	/** Reads open host questions through the session-host worker. */
	listUiRequests?: (sessionId: string) => Promise<PendingUiRequest[]>;
	/** The session's list title and the agent's latest reply, so a notification names the task and what changed. */
	describe?: (sessionId: string, reason: PushReason) => Promise<SessionDescription>;
	/** Test seam: clock for coalescing. */
	now?: () => number;
	log?: (message: string) => void;
}

export interface SessionDescription {
	title?: string;
	/** The agent's last reply, as text; only its first sentence is sent. */
	latestReply?: string;
}

export interface PushOutcome {
	/** Subscriptions a request was attempted for. */
	attempted: number;
	/** Subscriptions whose push service answered 2xx. */
	delivered: number;
}

export interface VapidKeys {
	publicKey: string;
	privateKey: string;
}

function isVapidKeys(value: unknown): value is VapidKeys {
	if (typeof value !== "object" || value === null) return false;
	const { publicKey, privateKey } = value as Record<string, unknown>;
	return (
		typeof publicKey === "string" &&
		typeof privateKey === "string" &&
		Buffer.from(publicKey, "base64url").byteLength === VAPID_PUBLIC_BYTES &&
		Buffer.from(privateKey, "base64url").byteLength === VAPID_PRIVATE_BYTES
	);
}

async function readVapidKeys(file: string): Promise<VapidKeys | undefined> {
	let text: string;
	try {
		text = await Bun.file(file).text();
	} catch (err) {
		if (isEnoent(err)) return undefined;
		throw err;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`${file} is not valid JSON; fix or delete it (deleting invalidates every stored subscription)`);
	}
	if (!isVapidKeys(parsed)) {
		throw new Error(`${file} does not hold a VAPID key pair; fix or delete it (deleting invalidates every stored subscription)`);
	}
	// A looser mode (copied from a backup, for example) is tightened, never trusted.
	await fs.chmod(file, 0o600);
	return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
}

async function loadOrCreateVapidKeys(stateDir: string): Promise<VapidKeys> {
	const file = path.join(stateDir, VAPID_FILE);
	const existing = await readVapidKeys(file);
	if (existing) return existing;
	const generated = webpush.generateVAPIDKeys();
	const tmp = `${file}.${process.pid}.tmp`;
	await fs.writeFile(tmp, `${JSON.stringify(generated)}\n`, { mode: 0o600 });
	try {
		// link() fails with EEXIST when another daemon on the same state dir won the race: then its key wins.
		await fs.link(tmp, file);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
	} finally {
		await fs.rm(tmp, { force: true });
	}
	const stored = await readVapidKeys(file);
	if (!stored) throw new Error(`${file} vanished right after it was created`);
	return stored;
}

function cleanTitle(title: string | undefined): string {
	// Control characters and whitespace runs become single spaces; the title is only ever the session's own title.
	const flat = (title ?? "").replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
	if (flat === "") return FALLBACK_TITLE;
	const chars = Array.from(flat);
	return chars.length > MAX_TITLE_CHARS ? `${chars.slice(0, MAX_TITLE_CHARS - 1).join("")}…` : flat;
}

function finishedTitle(title: string): string {
	const suffix = " finished";
	const chars = Array.from(title);
	const room = MAX_TITLE_CHARS - suffix.length;
	return `${chars.length > room ? `${chars.slice(0, room - 1).join("")}…` : title}${suffix}`;
}

/**
 * First prose sentence of a reply: "Finished writing the sample questions." Code and math blocks, tables, HTML and
 * Markdown decoration never reach the lock screen; a heading is used only when nothing else is there.
 */
export function updateLine(reply: string | undefined): string | undefined {
	if (!reply) return undefined;
	let heading: string | undefined;
	let fence: string | undefined;
	for (const raw of reply.split("\n")) {
		const trimmed = raw.trim();
		const marker = /^(```|~~~|\$\$)/.exec(trimmed)?.[1];
		if (fence !== undefined) {
			if (trimmed.startsWith(fence)) fence = undefined;
			continue;
		}
		if (marker !== undefined) {
			// A one-line `$$x$$` closes itself; anything else opens a block that is skipped to its closing marker.
			if (!(marker === "$$" && trimmed.length > 2 && trimmed.endsWith("$$"))) fence = marker;
			continue;
		}
		if (trimmed.startsWith("|") || trimmed.startsWith("<")) continue;
		const line = trimmed
			.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
			.replace(/<[^>]*>/g, "")
			.replace(/[`*~]+/g, "")
			.replace(/(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, "")
			.replace(/^\s*(?:>+|[-+]|\d+[.)])\s*/, "")
			.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ")
			.trim();
		if (line === "" || /^[-|: ]+$/.test(line)) continue;
		if (line.startsWith("#")) {
			heading ??= line.replace(/^#+\s*/, "");
			continue;
		}
		return firstSentence(line);
	}
	return heading ? firstSentence(heading) : undefined;
}

function firstSentence(line: string): string {
	// A sentence ends at CJK end punctuation, or at . ! ? before a space or the end, except after "e.g." and the like.
	let end = line.length;
	for (const match of line.matchAll(/[.!?](?=\s|$)|[。！？]/gu)) {
		if (match[0] === "." && SENTENCE_ABBREVIATION.test(line.slice(0, match.index))) continue;
		end = match.index + match[0].length;
		break;
	}
	const chars = Array.from(line.slice(0, end));
	return chars.length > MAX_UPDATE_CHARS ? `${chars.slice(0, MAX_UPDATE_CHARS - 1).join("")}…` : chars.join("");
}

const SENTENCE_ABBREVIATION = /(?:^|[\s(])(?:e\.g|i\.e|etc|vs|cf|approx|incl|Mr|Mrs|Ms|Dr)$/i;

function payloadFor(sessionId: string, reason: PushReason, title: string | undefined): PushPayload {
	const cleaned = cleanTitle(title);
	return {
		reason,
		sessionId,
		title: reason === "turn-finished" ? finishedTitle(cleaned) : cleaned,
		body: BODY_BY_REASON[reason],
		tag: `${sessionId}:${reason}`,
		url: `/#session=${encodeURIComponent(sessionId)}`,
	};
}

function hostOf(endpoint: string): string {
	try {
		return new URL(endpoint).host;
	} catch {
		return "invalid endpoint";
	}
}

export class PushSender {
	/** VAPID application server key (base64url), what `PushManager.subscribe` needs. */
	readonly publicKey: string;
	readonly #privateKey: string;
	readonly #store: PushStore;
	readonly #subject: string;
	readonly #ttlSeconds: number;
	readonly #coalesceMs: number;
	readonly #turnFinishedThresholdMs: number;
	readonly #timeoutMs: number;
	readonly #fetch: PushFetch;
	readonly #now: () => number;
	readonly #log: (message: string) => void;
	readonly #answerTokens: PushAnswerTokenStore | undefined;
	readonly #listUiRequests: ((sessionId: string) => Promise<PendingUiRequest[]>) | undefined;
	readonly #describe: ((sessionId: string, reason: PushReason) => Promise<SessionDescription>) | undefined;
	readonly #lastSent = new Map<string, number>();
	readonly #inflight = new Set<Promise<unknown>>();
	readonly #abort = new AbortController();

	/** Use `PushSender.open`, which supplies the VAPID key pair. */
	constructor(keys: VapidKeys, options: PushSenderOptions) {
		this.publicKey = keys.publicKey;
		this.#privateKey = keys.privateKey;
		this.#store = options.store;
		this.#subject = options.subject ?? DEFAULT_PUSH_SUBJECT;
		this.#ttlSeconds = options.ttlSeconds ?? DEFAULT_PUSH_TTL_SECONDS;
		this.#coalesceMs = options.coalesceMs ?? DEFAULT_PUSH_COALESCE_MS;
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_PUSH_TIMEOUT_MS;
		this.#turnFinishedThresholdMs = options.turnFinishedThresholdMs ?? DEFAULT_TURN_FINISHED_THRESHOLD_MS;
		this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
		this.#now = options.now ?? Date.now;
		this.#log = options.log ?? (() => {});
		this.#answerTokens = options.answerTokens;
		this.#listUiRequests = options.listUiRequests;
		this.#describe = options.describe;
	}

	/** Loads the VAPID key pair from the state dir, generating it on first run. */
	static async open(options: PushSenderOptions): Promise<PushSender> {
		return new PushSender(await loadOrCreateVapidKeys(options.stateDir), options);
	}

	/** Worker `notify` status: pushes `needs-answer`, `needs-approval` and `turn-finished`. Never rejects. */
	notify(event: NotifyEvent): Promise<void> {
		if (event.reason === "turn-finished" && (event.durationMs ?? 0) <= this.#turnFinishedThresholdMs) return Promise.resolve();
		return this.#dispatch(event.sessionId, event.reason, event.title);
	}

	/** Worker crash (every crash, restart or not; coalescing bounds a crash loop). Never rejects. */
	crashed(event: CrashEvent): Promise<void> {
		return this.#dispatch(event.sessionId, "worker-crashed", event.title);
	}
	/** Terminal overnight phases use distinct tags so the PWA shows the final outcome. */
	notifyOvernight(sessionId: string, phase: "complete" | "deadline" | "blocked", title?: string): Promise<void> {
		const reason: PushReason = `overnight-${phase}`;
		return this.#dispatch(sessionId, reason, title);
	}

	/** Sends a test notification to every stored subscription (not coalesced). */
	test(): Promise<PushOutcome> {
		return this.#track(
			this.#sendAll({
				reason: "turn-finished",
				sessionId: "omp-console-test",
				title: "omp console",
				body: "Test notification",
				tag: "omp-console-test:turn-finished",
				url: "/",
			}),
		);
	}

	/** Cancels in-flight requests and waits for them to settle. Pushes after close are dropped. */
	async close(): Promise<void> {
		this.#abort.abort();
		await Promise.allSettled([...this.#inflight]);
	}

	#dispatch(sessionId: string, reason: PushReason, title: string | undefined): Promise<void> {
		const payload = payloadFor(sessionId, reason, title);
		const now = this.#now();
		for (const [tag, at] of this.#lastSent) if (now - at >= this.#coalesceMs) this.#lastSent.delete(tag);
		if (this.#lastSent.has(payload.tag)) return Promise.resolve();
		// Marked before the first await so concurrent duplicates coalesce too.
		this.#lastSent.set(payload.tag, now);
		const prepare = async (): Promise<PushPayload> => {
			const described = await this.#described(payload, reason);
			return reason === "needs-answer" || reason === "needs-approval" ? this.#withAnswerChoices(described, reason) : described;
		};
		return this.#track(this.#sendAll(payload, prepare).then(outcome => this.#unmarkIfUnsent(payload.tag, outcome))).then(() => {});
	}

	#unmarkIfUnsent(tag: string, outcome: PushOutcome): void {
		// Nothing was sent (no subscriptions): a subscription added a moment later must not be silenced.
		if (outcome.attempted === 0) this.#lastSent.delete(tag);
	}

	#track<T>(promise: Promise<T>): Promise<T> {
		const tracked = promise.finally(() => this.#inflight.delete(tracked));
		this.#inflight.add(tracked);
		return tracked;
	}

	/** Names the task as the session list does and, for a finished turn, says what the agent last reported. */
	async #described(payload: PushPayload, reason: PushReason): Promise<PushPayload> {
		if (!this.#describe) return payload;
		let description: SessionDescription | undefined;
		let timer: Timer | undefined;
		try {
			description = await Promise.race([
				this.#describe(payload.sessionId, reason),
				new Promise<undefined>(resolve => {
					timer = setTimeout(resolve, DESCRIBE_TIMEOUT_MS);
				}),
			]);
		} catch {
			this.#log("push: unable to describe the session; sending with its worker title");
		} finally {
			clearTimeout(timer);
		}
		const title = description?.title ? cleanTitle(description.title) : undefined;
		if (reason !== "turn-finished") return title ? { ...payload, title } : payload;
		const update = updateLine(description?.latestReply);
		return {
			...payload,
			...(title ? { title: finishedTitle(title) } : {}),
			...(update ? { body: update } : {}),
		};
	}

	async #withAnswerChoices(payload: PushPayload, reason: "needs-answer" | "needs-approval"): Promise<PushPayload> {
		if (!this.#answerTokens || !this.#listUiRequests) return payload;
		let requests: PendingUiRequest[];
		try {
			requests = await this.#listUiRequests(payload.sessionId);
		} catch {
			this.#log("push: unable to read pending questions; sending without answer actions");
			return payload;
		}
		if (!Array.isArray(requests)) {
			this.#log("push: pending question response was invalid; sending without answer actions");
			return payload;
		}
		const answer = latestAnswerableChoices(requests, reason);
		if (!answer) return payload;
		return {
			...payload,
			// The buttons answer this exact question, so the notification says what it is.
			body: answer.question || payload.body,
			choices: answer.choices,
			reqId: answer.request.reqId,
			answerToken: this.#answerTokens.issue(payload.sessionId, answer.request, answer.choices),
		};
	}

	async #sendAll(payload: PushPayload, prepare?: () => Promise<PushPayload>): Promise<PushOutcome> {
		if (this.#abort.signal.aborted) return { attempted: 0, delivered: 0 };
		let subscriptions: StoredPushSubscription[];
		try {
			subscriptions = await this.#store.list();
		} catch (err) {
			this.#log(`push: cannot read subscriptions: ${err instanceof Error ? err.message : String(err)}`);
			return { attempted: 0, delivered: 0 };
		}
		let outgoing = payload;
		if (prepare) {
			try {
				outgoing = await prepare();
			} catch {
				this.#log("push: unable to prepare answer actions; sending without them");
			}
		}
		const body = JSON.stringify(outgoing);
		const results = await Promise.all(subscriptions.map(subscription => this.#sendOne(subscription, body)));
		return { attempted: subscriptions.length, delivered: results.filter(Boolean).length };
	}

	/** True when the push service accepted the message. Never throws. */
	async #sendOne(subscription: StoredPushSubscription, body: string): Promise<boolean> {
		const host = hostOf(subscription.endpoint);
		try {
			const details = webpush.generateRequestDetails(
				{ endpoint: subscription.endpoint, keys: subscription.keys },
				body,
				{
					vapidDetails: { subject: this.#subject, publicKey: this.publicKey, privateKey: this.#privateKey },
					TTL: this.#ttlSeconds,
					urgency: "high",
				},
			);
			const headers = new Headers();
			for (const [name, value] of Object.entries(details.headers)) {
				if (name.toLowerCase() !== "content-length") headers.set(name, String(value));
			}
			const response = await this.#fetch(details.endpoint, {
				method: details.method,
				headers,
				body: details.body,
				redirect: "error",
				signal: AbortSignal.any([this.#abort.signal, AbortSignal.timeout(this.#timeoutMs)]),
			});
			await response.body?.cancel().catch(() => {});
			if (response.status >= 200 && response.status < 300) return true;
			if (response.status === 404 || response.status === 410) {
				await this.#store.remove(subscription.endpoint);
				this.#log(`push: ${host} reports the subscription gone (${response.status}); removed`);
				return false;
			}
			this.#log(`push: ${host} answered ${response.status}`);
			return false;
		} catch (err) {
			// Only the message: the error for a bad key or a refused connection never carries the keys.
			this.#log(`push: delivery to ${host} failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}
}
