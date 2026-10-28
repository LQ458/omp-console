/**
 * Web Push subscription store. Persists subscriptions as JSON under the state dir (mode 0600); `push-sender.ts`
 * reads it to deliver notifications and removes subscriptions the push service reports gone.
 */
import type { PushSubscriptionRequest } from "@omp-console/protocol";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";

export interface StoredPushSubscription extends PushSubscriptionRequest {
	createdAt: number;
}

const KEY_RE = /^[A-Za-z0-9_+/=-]+$/;
const MAX_ENDPOINT = 2048;
/** Uncompressed P-256 point (`0x04 || X || Y`) and the 16-byte auth secret, as in RFC 8291. */
const P256DH_BYTES = 65;
const AUTH_BYTES = 16;

function decodedLength(value: string): number {
	return Buffer.from(value, "base64url").byteLength;
}

/** Returns the validated subscription or a human-readable reason. */
export function parsePushSubscription(body: unknown): PushSubscriptionRequest | string {
	if (typeof body !== "object" || body === null || Array.isArray(body)) return "body must be a JSON object";
	const { endpoint, keys, label } = body as Record<string, unknown>;
	if (typeof endpoint !== "string" || endpoint.length === 0 || endpoint.length > MAX_ENDPOINT) {
		return "endpoint must be a non-empty URL string";
	}
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		return "endpoint is not a valid URL";
	}
	if (url.protocol !== "https:") return "endpoint must be an https URL";
	if (typeof keys !== "object" || keys === null) return "keys.p256dh and keys.auth are required";
	const { p256dh, auth } = keys as Record<string, unknown>;
	if (typeof p256dh !== "string" || !KEY_RE.test(p256dh) || decodedLength(p256dh) !== P256DH_BYTES) return "keys.p256dh is invalid";
	if (typeof auth !== "string" || !KEY_RE.test(auth) || decodedLength(auth) !== AUTH_BYTES) return "keys.auth is invalid";
	if (label !== undefined && (typeof label !== "string" || label.length > 64)) return "label must be a string of at most 64 characters";
	const result: PushSubscriptionRequest = { endpoint, keys: { p256dh, auth } };
	if (label !== undefined) result.label = label;
	return result;
}

export class PushStore {
	readonly #file: string;
	#chain: Promise<unknown> = Promise.resolve();

	constructor(stateDir: string) {
		this.#file = path.join(stateDir, "push-subscriptions.json");
	}

	async list(): Promise<StoredPushSubscription[]> {
		try {
			const parsed: unknown = JSON.parse(await Bun.file(this.#file).text());
			return Array.isArray(parsed) ? (parsed as StoredPushSubscription[]) : [];
		} catch (err) {
			if (isEnoent(err)) return [];
			throw err;
		}
	}

	/** Adds or replaces (by endpoint) a subscription. Writes are serialized and atomic. */
	add(subscription: PushSubscriptionRequest): Promise<void> {
		return this.#update(existing => [
			...existing.filter(item => item.endpoint !== subscription.endpoint),
			{ ...subscription, createdAt: Date.now() },
		]);
	}

	/** Removes a subscription by endpoint; resolves to false when it was not stored. */
	async remove(endpoint: string): Promise<boolean> {
		let removed = false;
		await this.#update(existing => {
			const kept = existing.filter(item => item.endpoint !== endpoint);
			removed = kept.length !== existing.length;
			return removed ? kept : undefined;
		});
		return removed;
	}

	#update(change: (existing: StoredPushSubscription[]) => StoredPushSubscription[] | undefined): Promise<void> {
		const task = this.#chain.then(async () => {
			const next = change(await this.list());
			if (!next) return;
			const tmp = `${this.#file}.${process.pid}.tmp`;
			await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
			await fs.rename(tmp, this.#file);
		});
		this.#chain = task.catch(() => {});
		return task;
	}
}
