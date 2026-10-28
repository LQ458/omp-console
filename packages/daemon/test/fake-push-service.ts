/**
 * A local stand-in for a browser push service (FCM, Apple, Mozilla). It receives the daemon's real
 * `web-push` requests, verifies the VAPID `Authorization` JWT (ES256 signature, `aud`, `exp`, `sub`), and
 * decrypts the aes128gcm body (RFC 8291) with the test subscription's private key, using only `node:crypto`.
 *
 * Real push endpoints are https URLs on foreign hosts, so subscriptions use the fake origin `https://push.test.invalid`
 * and `fetch` (the daemon's `pushFetch` seam) rewrites that origin to the local HTTP server.
 */
import type { PushPayload } from "@omp-console/protocol";
import * as crypto from "node:crypto";
import type { PushFetch } from "../src/push-sender";

export const PUSH_ORIGIN = "https://push.test.invalid";

export interface Subscriber {
	endpoint: string;
	keys: { p256dh: string; auth: string };
	/** Subscription key pair; only the test holds the private half. */
	ecdh: crypto.ECDH;
	authSecret: Buffer;
}

export function makeSubscriber(pathname: string): Subscriber {
	const ecdh = crypto.createECDH("prime256v1");
	ecdh.generateKeys();
	const authSecret = crypto.randomBytes(16);
	return {
		endpoint: `${PUSH_ORIGIN}${pathname}`,
		keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: authSecret.toString("base64url") },
		ecdh,
		authSecret,
	};
}

function hkdf(ikm: Buffer, salt: Buffer, info: Buffer, length: number): Buffer {
	return Buffer.from(crypto.hkdfSync("sha256", ikm, salt, info, length));
}

/** RFC 8291 decryption of a single-record aes128gcm message. */
export function decryptAes128gcm(body: Buffer, subscriber: Subscriber): string {
	const salt = body.subarray(0, 16);
	const recordSize = body.readUInt32BE(16);
	const keyIdLength = body[20]!;
	const serverPublic = body.subarray(21, 21 + keyIdLength);
	const cipher = body.subarray(21 + keyIdLength);
	if (recordSize < 18 || cipher.byteLength > recordSize) throw new Error("not a single aes128gcm record");
	const secret = subscriber.ecdh.computeSecret(serverPublic);
	const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), subscriber.ecdh.getPublicKey(), serverPublic]);
	const ikm = hkdf(secret, subscriber.authSecret, keyInfo, 32);
	const key = hkdf(ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
	const nonce = hkdf(ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12);
	const decipher = crypto.createDecipheriv("aes-128-gcm", key, nonce);
	decipher.setAuthTag(cipher.subarray(cipher.byteLength - 16));
	const padded = Buffer.concat([decipher.update(cipher.subarray(0, cipher.byteLength - 16)), decipher.final()]);
	let end = padded.byteLength;
	while (end > 0 && padded[end - 1] === 0) end--;
	if (padded[end - 1] !== 2) throw new Error("missing last-record delimiter");
	return padded.subarray(0, end - 1).toString("utf8");
}

export interface VapidClaims {
	aud: string;
	exp: number;
	sub: string;
}

/** Verifies `Authorization: vapid t=<jwt>, k=<public key>` and returns the claims; throws on any defect. */
export function verifyVapid(authorization: string, expectedPublicKey: string, expectedAudience: string): VapidClaims {
	const match = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(authorization);
	if (!match) throw new Error(`not a vapid Authorization header: ${authorization.slice(0, 20)}`);
	const [, jwt, k] = match;
	if (k !== expectedPublicKey) throw new Error("k is not the daemon's public key");
	const [encodedHeader, encodedClaims, encodedSignature] = jwt!.split(".") as [string, string, string];
	const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as { typ: string; alg: string };
	if (header.typ !== "JWT" || header.alg !== "ES256") throw new Error(`bad JWT header ${JSON.stringify(header)}`);
	const raw = Buffer.from(k!, "base64url");
	if (raw.byteLength !== 65 || raw[0] !== 4) throw new Error("k is not an uncompressed P-256 point");
	const publicKey = crypto.createPublicKey({
		key: { kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33).toString("base64url") },
		format: "jwk",
	});
	const signature = Buffer.from(encodedSignature, "base64url");
	const valid = crypto.verify("sha256", Buffer.from(`${encodedHeader}.${encodedClaims}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, signature);
	if (!valid) throw new Error("JWT signature does not verify");
	const claims = JSON.parse(Buffer.from(encodedClaims, "base64url").toString("utf8")) as VapidClaims;
	if (claims.aud !== expectedAudience) throw new Error(`aud ${claims.aud} != ${expectedAudience}`);
	const now = Math.floor(Date.now() / 1000);
	if (!Number.isInteger(claims.exp) || claims.exp <= now) throw new Error("JWT already expired");
	if (claims.exp > now + 24 * 3600) throw new Error("JWT lives longer than 24 h");
	if (!/^(mailto:\S+@\S+|https:\/\/\S+)$/.test(claims.sub)) throw new Error(`bad sub ${claims.sub}`);
	return claims;
}

export interface ReceivedPush {
	pathname: string;
	headers: Record<string, string>;
	claims: VapidClaims;
	payload: PushPayload;
	/** The decrypted JSON text, for leak checks. */
	text: string;
}

export type Behavior = number | "hang";

export class FakePushService {
	readonly received: ReceivedPush[] = [];
	/** Every request that reached the service, including refused ones (for retry counting). */
	readonly requests: string[] = [];
	/** Why the service refused a request that failed VAPID or decryption checks (empty when the daemon is correct). */
	readonly rejections: string[] = [];
	readonly #behavior = new Map<string, Behavior>();
	readonly #subscribers = new Map<string, Subscriber>();
	readonly #server: Bun.Server<undefined>;
	readonly #vapidPublicKey: () => string;

	/** `vapidPublicKey` is read per request because the daemon generates it on first start. */
	constructor(vapidPublicKey: () => string) {
		this.#vapidPublicKey = vapidPublicKey;
		this.#server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => this.#handle(req) });
	}

	/** Creates a subscription whose push endpoint answers `behavior` (201 unless told otherwise). */
	subscribe(pathname: string, behavior: Behavior = 201): Subscriber {
		const subscriber = makeSubscriber(pathname);
		this.#subscribers.set(pathname, subscriber);
		this.#behavior.set(pathname, behavior);
		return subscriber;
	}

	/** Pushes accepted for one subscription path, in arrival order. */
	pushesTo(pathname: string): ReceivedPush[] {
		return this.received.filter(push => push.pathname === pathname);
	}

	/** The daemon's `pushFetch`: the fake https origin is served by this local server. */
	readonly fetch: PushFetch = (url, init) => {
		if (!url.startsWith(`${PUSH_ORIGIN}/`)) throw new Error(`unexpected push endpoint ${url}`);
		return fetch(`http://127.0.0.1:${this.#server.port}${url.slice(PUSH_ORIGIN.length)}`, init);
	};

	async #handle(req: Request): Promise<Response> {
		const pathname = new URL(req.url).pathname;
		this.requests.push(pathname);
		const behavior = this.#behavior.get(pathname);
		const subscriber = this.#subscribers.get(pathname);
		if (behavior === undefined || !subscriber) return new Response(null, { status: 404 });
		if (behavior === "hang") return new Promise<Response>(() => {});
		if (behavior !== 201) return new Response(null, { status: behavior });
		const headers: Record<string, string> = {};
		for (const [name, value] of req.headers) headers[name] = value;
		try {
			const claims = verifyVapid(headers.authorization ?? "", this.#vapidPublicKey(), PUSH_ORIGIN);
			const text = decryptAes128gcm(Buffer.from(await req.arrayBuffer()), subscriber);
			this.received.push({ pathname, headers, claims, payload: JSON.parse(text) as PushPayload, text });
			return new Response(null, { status: 201 });
		} catch (err) {
			// A request that fails verification is a daemon bug: answer 403 and keep the reason for the test.
			this.rejections.push(err instanceof Error ? err.message : String(err));
			return new Response(null, { status: 403 });
		}
	}

	stop(): void {
		void this.#server.stop(true);
	}
}
