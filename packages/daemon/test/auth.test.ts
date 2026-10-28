import { afterEach, describe, expect, it } from "bun:test";
import type { ApiError } from "@omp-console/protocol";
import { checkRequest, isLoopbackAddress, normalizeAllowedHosts } from "../src/auth";
import { startTestDaemon, stopTestDaemons } from "./harness";

afterEach(stopTestDaemons);

const OWNER = "alice@example.com";

describe("auth matrix over the real server", () => {
	it("accepts loopback without proxy headers", async () => {
		const t = await startTestDaemon({ owner: OWNER });
		expect((await t.get("/api/health")).status).toBe(200);
	});

	it("rejects a spoofed Tailscale login from the wrong user, even from loopback", async () => {
		const t = await startTestDaemon({ owner: OWNER });
		const res = await t.get("/api/health", { "Tailscale-User-Login": "mallory@example.com" });
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "unauthorized", code: "unauthorized" } satisfies ApiError);
	});

	it("accepts the owner's Tailscale login with the proxy headers tailscale serve adds", async () => {
		const t = await startTestDaemon({ owner: OWNER });
		const res = await t.get("/api/health", {
			"Tailscale-User-Login": "ALICE@EXAMPLE.COM",
			"X-Forwarded-For": "100.101.102.103",
			"X-Forwarded-Proto": "https",
		});
		expect(res.status).toBe(200);
	});
	it("does not treat a matching Tailscale login as a device credential", async () => {
		const t = await startTestDaemon({ owner: OWNER, pair: false });
		const res = await t.unauthenticated("/api/health", "GET", undefined, { "Tailscale-User-Login": OWNER });
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "unauthorized", code: "unauthorized" } satisfies ApiError);
	});

	it("rejects a proxied request that has no owner login, and any login when no owner is configured", async () => {
		const t = await startTestDaemon({ owner: OWNER });
		expect((await t.get("/api/health", { "X-Forwarded-For": "100.64.0.9" })).status).toBe(401);
		expect((await t.get("/api/health", { "Tailscale-App-Capabilities": "{}" })).status).toBe(401);
		const open = await startTestDaemon({});
		expect((await open.get("/api/health", { "Tailscale-User-Login": OWNER })).status).toBe(401);
	});

	it("rejects non-loopback peers with and without headers (test seam)", async () => {
		let remote = "127.0.0.1";
		const t = await startTestDaemon({ owner: OWNER, remoteAddress: () => remote });
		remote = "203.0.113.5";
		expect((await t.get("/api/health")).status).toBe(401);
		expect((await t.get("/api/health", { "Tailscale-User-Login": OWNER })).status).toBe(401);
	});

	it("guards static files and the relay path too, not just /api", async () => {
		const t = await startTestDaemon({ owner: OWNER });
		const hdr = { "Tailscale-User-Login": "mallory@example.com" };
		expect((await t.get("/", hdr)).status).toBe(401);
		expect((await t.get("/r/RelayRoom_12345?role=host", hdr)).status).toBe(401);
		expect((await t.post("/api/sessions", { cwd: t.dir }, hdr)).status).toBe(401);
		expect(t.daemon.supervisor.list()).toHaveLength(0);
		// Same relay request from an authorised caller reaches the relay (426: not a websocket upgrade).
		expect((await t.get("/r/RelayRoom_12345?role=host")).status).toBe(426);
	});
	it("rejects non-owner raw session uploads before route dispatch", async () => {
		const t = await startTestDaemon({ owner: OWNER });
		const response = await fetch(`${t.url}/api/sessions/session-1/uploads?name=private.txt`, {
			method: "POST",
			headers: { Cookie: t.cookie, "Tailscale-User-Login": "mallory@example.com", "content-type": "application/octet-stream" },
			body: new Uint8Array([1, 2, 3]),
		});

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "unauthorized", code: "unauthorized" } satisfies ApiError);
	});

});

describe("isLoopbackAddress", () => {
	it("recognises IPv4, IPv6 and v4-mapped loopback only", () => {
		expect(["127.0.0.1", "127.9.9.9", "::1", "::ffff:127.0.0.1"].map(isLoopbackAddress)).toEqual([true, true, true, true]);
		expect(["10.0.0.1", "100.64.0.1", "::ffff:10.0.0.1", "127.0.0.1.evil.example", "", undefined].map(isLoopbackAddress)).toEqual([
			false,
			false,
			false,
			false,
			false,
			false,
		]);
	});
});

describe("checkRequest", () => {
	const config = { owner: OWNER, allowedHosts: normalizeAllowedHosts() };

	it("ignores header-name case on the Tailscale login", () => {
		const headers = new Headers({ host: "localhost:7481", "tailscale-USER-login": OWNER });
		expect(checkRequest(headers, "127.0.0.1", config)).toBeNull();
	});

	it("refuses a request without a Host header (fail closed)", () => {
		expect(checkRequest(new Headers(), "127.0.0.1", config)).toEqual({ status: 421, message: "host not allowed" });
	});
});
