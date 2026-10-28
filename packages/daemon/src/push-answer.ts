import type {
	ApiError,
	PendingUiRequest,
	PushAnswerRequest,
	SessionOpResult,
	SessionOpV3,
	SessionOpV3Result,
} from "@omp-console/protocol";

export const PUSH_ANSWER_TOKEN_TTL_MS = 30 * 60 * 1000;

interface PushAnswerRecord {
	sessionId: string;
	reqId: string;
	/** The exact question the notification showed (see `questionFingerprint`). */
	question: string;
	choices: readonly string[];
	expiresAt: number;
}

/**
 * Identity of one open question beyond its `reqId`: a worker restart starts `reqId`s again from 1, so a stale
 * notification's token must never answer a newer question that happens to reuse the number.
 */
export function questionFingerprint(request: PendingUiRequest): string {
	return JSON.stringify([request.reqId, request.at, request.title, (request.options ?? []).map(option => option.label)]);
}


export type PushAnswerClaim =
	| { kind: "missing" }
	| { kind: "invalid-value" }
	| { kind: "claimed"; answer: PushAnswerRecord };

export class PushAnswerTokenStore {
	readonly #tokens = new Map<string, PushAnswerRecord>();
	readonly #now: () => number;

	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	issue(sessionId: string, request: PendingUiRequest, choices: readonly string[]): string {
		this.#pruneExpired();
		let token: string;
		do {
			token = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
		} while (this.#tokens.has(token));
		this.#tokens.set(token, {
			sessionId,
			reqId: request.reqId,
			question: questionFingerprint(request),
			choices: [...choices],
			expiresAt: this.#now() + PUSH_ANSWER_TOKEN_TTL_MS,
		});
		return token;
	}

	claim(token: string, value: string): PushAnswerClaim {
		this.#pruneExpired();
		const record = this.#tokens.get(token);
		if (!record) return { kind: "missing" };
		if (!record.choices.includes(value)) return { kind: "invalid-value" };
		this.#tokens.delete(token);
		return { kind: "claimed", answer: { ...record } };
	}

	/** Puts back a claimed token whose answer never reached the session (a timeout), so the button can be tapped again. */
	restore(token: string, answer: PushAnswerRecord): void {
		if (answer.expiresAt > this.#now()) this.#tokens.set(token, { ...answer });
	}

	#pruneExpired(): void {
		const now = this.#now();
		for (const [token, record] of this.#tokens) {
			if (record.expiresAt <= now) this.#tokens.delete(token);
		}
	}
}

interface PushAnswerRoutePorts {
	tokens: PushAnswerTokenStore;
	readJson(req: Request): Promise<unknown>;
	json(status: number, body: unknown): Response;
	errorResponse(status: number, code: ApiError["code"], message: string): Response;
	sessionOp(sessionId: string, op: SessionOpV3): Promise<SessionOpResult | SessionOpV3Result>;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
	if (!isObject(error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

function answerRequest(value: unknown): PushAnswerRequest | undefined {
	if (!isObject(value) || typeof value.token !== "string" || typeof value.value !== "string") return undefined;
	return { token: value.token, value: value.value };
}
interface PushAnswerOptionsRequest {
	sessionId: string;
	reason: "needs-answer" | "needs-approval";
}

function pushAnswerOptionsRequest(value: unknown): PushAnswerOptionsRequest | undefined {
	if (!isObject(value) || typeof value.sessionId !== "string" || value.sessionId.length === 0) return undefined;
	if (value.reason !== "needs-answer" && value.reason !== "needs-approval") return undefined;
	return { sessionId: value.sessionId, reason: value.reason };
}

export function createPushAnswerOptionsRoute(
	ports: PushAnswerRoutePorts,
): (req: Request) => Promise<Response> {
	return async req => {
		if (req.method !== "POST") {
			return ports.errorResponse(405, "bad-request", `method ${req.method} not allowed`);
		}
		const body = pushAnswerOptionsRequest(await ports.readJson(req));
		if (!body) {
			return ports.errorResponse(
				400,
				"bad-request",
				'body must be {"sessionId": string, "reason": "needs-answer" | "needs-approval"}',
			);
		}
		let pending: SessionOpResult | SessionOpV3Result;
		try {
			pending = await ports.sessionOp(body.sessionId, { op: "ui-requests" });
		} catch (error) {
			const code = errorCode(error);
			if (code === "bad-request" || code === "conflict" || code === "not-found") return ports.json(200, {});
			throw error;
		}
		const requests = "uiRequests" in pending && Array.isArray(pending.uiRequests) ? pending.uiRequests : [];
		const answer = latestAnswerableChoices(requests, body.reason);
		if (!answer) return ports.json(200, {});
		return ports.json(200, {
			choices: answer.choices,
			question: answer.question,
			reqId: answer.request.reqId,
			answerToken: ports.tokens.issue(body.sessionId, answer.request, answer.choices),
		});
	};
}


export function latestAnswerableChoices(
	requests: readonly PendingUiRequest[],
	reason: "needs-answer" | "needs-approval",
): { request: PendingUiRequest; choices: string[]; question: string } | undefined {
	let newest: PendingUiRequest | undefined;
	for (const request of requests) {
		if (!newest || request.at >= newest.at) newest = request;
	}
	if (
		!newest ||
		newest.kind !== "select" ||
		newest.options === undefined ||
		newest.options.length === 0 ||
		newest.options.length > 3 ||
		newest.checkedIndices !== undefined ||
		newest.markableCount !== undefined
	) {
		return undefined;
	}
	let choices = newest.options.map(option => option.label);
	if (choices.some(choice => choice.trim() === "")) return undefined;
	// A tool approval (whatever the push reason says): only the once-only grant and deny go on a notification. Wider
	// grants ("for session", "Always Approve Directory") need the full prompt in the app.
	const approval = reason === "needs-approval" || choices.some(label => /\b(approve|deny|allow|reject)\b/i.test(label));
	const question = notificationQuestion(newest.title);
	if (approval) {
		// Approve from a notification only when the notification shows the whole request: no truncation, no
		// direction-override characters that can make the command read differently than it runs.
		if (question === "" || question.length > NOTIFICATION_QUESTION_MAX || BIDI_CONTROLS.test(newest.title)) return undefined;
		const onceLabels = choices.filter(label => /^(approve|approve once|allow|allow once)$/i.test(label.trim()));
		const deny = choices.find(label => /^(deny|reject)$/i.test(label.trim()));
		// Two approve-like labels (e.g. "Approve" for a grant next to "Approve Once") are ambiguous: open the app.
		if (onceLabels.length !== 1 || deny === undefined) return undefined;
		choices = [onceLabels[0]!, deny];
	}
	return { request: newest, choices, question: question.length > NOTIFICATION_QUESTION_MAX ? `${question.slice(0, NOTIFICATION_QUESTION_MAX - 1)}…` : question };
}

/** The question as a notification body: what a one-tap answer is about (the command for an approval). */
function notificationQuestion(title: string): string {
	return title.replace(BIDI_CONTROLS_GLOBAL, "").replace(/\s+/g, " ").trim();
}

const NOTIFICATION_QUESTION_MAX = 240;
const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
const BIDI_CONTROLS_GLOBAL = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

export function createPushAnswerRoute(ports: PushAnswerRoutePorts): (req: Request) => Promise<Response> {
	return async req => {
		if (req.method !== "POST") {
			return ports.errorResponse(405, "bad-request", `method ${req.method} not allowed`);
		}
		const body = answerRequest(await ports.readJson(req));
		if (!body) return ports.errorResponse(400, "bad-request", 'body must be {"token": string, "value": string}');

		const claim = ports.tokens.claim(body.token, body.value);
		if (claim.kind === "missing") return ports.errorResponse(404, "not-found", "answer token is unknown, expired, or used");
		if (claim.kind === "invalid-value") return ports.errorResponse(400, "bad-request", "value is not one of the notification choices");

		try {
			const pending = await ports.sessionOp(claim.answer.sessionId, { op: "ui-requests" });
			if (!("uiRequests" in pending) || !pending.uiRequests.some(request => questionFingerprint(request) === claim.answer.question)) {
				return ports.errorResponse(409, "conflict", "question already closed");
			}
			await ports.sessionOp(claim.answer.sessionId, {
				op: "ui-answer",
				reqId: claim.answer.reqId,
				value: body.value,
			});
			return ports.json(200, { ok: true });
		} catch (error) {
			const code = errorCode(error);
			if (code === "conflict" || code === "not-found") {
				return ports.errorResponse(409, "conflict", "question already closed");
			}
			// Not delivered (the session did not answer in time): the notification's token stays usable.
			ports.tokens.restore(body.token, claim.answer);
			return ports.errorResponse(503, "internal", "the session did not take the answer; try again");
		}
	};
}
