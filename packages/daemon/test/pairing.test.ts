import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { DeviceAuthStore } from "../src/device-auth";
import { createPairingRoutes } from "../src/pairing-routes";
import { closeAllSockets, socket, waitEvent, waitOpen } from "./ws-helpers";
import { makeTmp } from "./helpers";
import { rawRequest, startTestDaemon, stopTestDaemons } from "./harness";

const COOKIE_NAME = "omc_device";

afterEach(async () => {
	closeAllSockets();
	await stopTestDaemons();
});

describe("device pairing", () => {
	it("issues one-time device cookies, persists only hashes, and reports request pairing status", async () => {
		const t = await startTestDaemon({ pair: false, owner: "owner@example.com", allowHosts: ["pair.ts.net"] });
		const codePath = path.join(t.stateDir, "pairing-code");
		const startupCode = fs.readFileSync(codePath, "utf8").trim();
		expect(startupCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
		if (process.platform !== "win32") expect(fs.statSync(codePath).mode & 0o777).toBe(0o600);

		const first = await t.unauthenticated("/api/pair", "POST", { code: startupCode, label: "Desktop" });
		expect(first.status).toBe(200);
		const firstCookieHeader = first.headers.get("set-cookie") ?? "";
		expect(firstCookieHeader).toContain("HttpOnly");
		expect(firstCookieHeader).toContain("SameSite=Strict");
		expect(firstCookieHeader).toContain("Path=/");
		expect(firstCookieHeader).toContain("Max-Age=34560000");
		expect(firstCookieHeader).not.toContain("Secure");
		const firstCookie = firstCookieHeader.split(";", 1)[0]!;
		const firstDevice = (await first.json()) as { deviceId: string };
		expect(firstDevice.deviceId).toBeString();
		const firstToken = firstCookie.slice(`${COOKIE_NAME}=`.length);
		expect((await t.unauthenticated("/api/health", "GET", undefined, { Authorization: `Bearer ${firstToken}` })).status).toBe(200);
		const invalidToken = Buffer.alloc(32, 255).toString("base64url");
		expect((await t.unauthenticated("/api/health", "GET", undefined, { Authorization: `Bearer ${invalidToken}` })).status).toBe(401);

		const status = await t.get("/api/pair/status", { Cookie: firstCookie });
		expect(await status.json()).toEqual({ paired: true });
		const devicesResponse = await t.get("/api/devices", { Cookie: firstCookie });
		const devices = (await devicesResponse.json()) as { devices: Array<{ id: string; label: string; createdAt: number; lastSeenAt: number }>; currentDeviceId: string };
		expect(devices.devices).toHaveLength(1);
		const device = devices.devices[0];
		if (!device) throw new Error("paired device was not listed");
		expect(device.id).toBe(firstDevice.deviceId);
		expect(device.label).toBe("Desktop");
		expect(Number.isFinite(device.createdAt)).toBe(true);
		expect(Number.isFinite(device.lastSeenAt)).toBe(true);
		expect(devices.currentDeviceId).toBe(firstDevice.deviceId);

		const persisted = JSON.parse(fs.readFileSync(path.join(t.stateDir, "devices.json"), "utf8")) as Array<Record<string, unknown>>;
		if (process.platform !== "win32") expect(fs.statSync(path.join(t.stateDir, "devices.json")).mode & 0o777).toBe(0o600);
		expect(persisted).toHaveLength(1);
		expect(persisted[0]?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
		expect(JSON.stringify(persisted)).not.toContain(firstCookie.slice(`${COOKIE_NAME}=`.length));

		const usedAgain = await t.unauthenticated("/api/pair", "POST", { code: startupCode, label: "Phone" });
		expect(usedAgain.status).toBe(410);

		const additionalCodeResponse = await t.post("/api/pair/code", {}, { Cookie: firstCookie });
		const additionalCode = (await additionalCodeResponse.json()) as { code: string };
		const securePair = await t.unauthenticated(
			"/api/pair",
			"POST",
			{ code: additionalCode.code, label: "Phone" },
			{
				"Tailscale-User-Login": "owner@example.com",
				"X-Forwarded-For": "100.64.0.1",
				"X-Forwarded-Host": "pair.ts.net",
				"X-Forwarded-Proto": "https",
			},
		);
		expect(securePair.status).toBe(200);
		expect(securePair.headers.get("set-cookie")).toContain("; Secure");
		expect(securePair.headers.get("set-cookie")).toContain("HttpOnly");
		const phoneCookie = (securePair.headers.get("set-cookie") ?? "").split(";", 1)[0]!;
		const expanded = (await (await t.get("/api/devices", { Cookie: firstCookie })).json()) as {
			devices: Array<{ id: string; label: string }>;
			currentDeviceId: string;
		};
		expect(expanded.devices).toHaveLength(2);
		const phone = expanded.devices.find(device => device.label === "Phone");
		if (!phone) throw new Error("newly paired phone is missing from the device list");
		expect(expanded.currentDeviceId).toBe(firstDevice.deviceId);
		const revoked = await t.del(`/api/devices/${phone.id}`, { Cookie: firstCookie });
		expect(await revoked.json()).toMatchObject({ revoked: phone.id, loggedOut: false });
		expect((await t.unauthenticated("/api/health", "GET", undefined, { Cookie: phoneCookie })).status).toBe(401);
		expect((await t.get("/api/health", { Cookie: firstCookie })).status).toBe(200);
	});

	it("burns a code after five wrong attempts and rate-limits pairing globally", async () => {
		const t = await startTestDaemon({ pair: false });
		const code = fs.readFileSync(path.join(t.stateDir, "pairing-code"), "utf8").trim();
		const wrongCode = `${code[0] === "0" ? "1" : "0"}${code.slice(1, 4)}-${code.slice(5)}`;
		const statuses: number[] = [];
		for (let attempt = 0; attempt < 5; attempt++) {
			const response = await t.unauthenticated("/api/pair", "POST", { code: wrongCode, label: "Browser" });
			statuses.push(response.status);
		}
		expect(statuses).toEqual([400, 400, 400, 400, 400]);
		expect(fs.existsSync(path.join(t.stateDir, "pairing-code"))).toBe(false);
		const burned = await t.unauthenticated("/api/pair", "POST", { code, label: "Browser" });
		expect(burned.status).toBe(410);
		for (let attempt = 0; attempt < 4; attempt++) {
			await t.unauthenticated("/api/pair", "POST", { code: "not-a-code", label: "Browser" });
		}
		const limited = await t.unauthenticated("/api/pair", "POST", { code: "not-a-code", label: "Browser" });
		expect(limited.status).toBe(429);
		expect(limited.headers.get("retry-after")).toBeString();
	});

	it("refuses expired pairing codes and removes their private file", async () => {
		const stateDir = makeTmp("omp-console-pair-expiry-");
		let now = 1_800_000_000_000;
		const store = await DeviceAuthStore.open(stateDir, () => {}, () => now);
		try {
			const code = fs.readFileSync(path.join(stateDir, "pairing-code"), "utf8").trim();
			now += 10 * 60_000;
			const route = createPairingRoutes({ store, isSecure: () => false, onRevoked: () => {} });
			const request = new Request("http://127.0.0.1/api/pair", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ code, label: "Browser" }),
			});
			const response = await route(request, new URL(request.url));
			expect(response?.status).toBe(410);
			expect(fs.existsSync(path.join(stateDir, "pairing-code"))).toBe(false);
		} finally {
			await store.close();
		}
	});

	it("a revoke whose save fails keeps the device, so a retry works and a restart never resurrects it", async () => {
		const stateDir = makeTmp("omp-console-pair-revoke-");
		let store = await DeviceAuthStore.open(stateDir, () => {});
		const code = fs.readFileSync(path.join(stateDir, "pairing-code"), "utf8").trim();
		const paired = await store.pair(code, "Phone");
		if (!paired.ok) throw new Error(`pairing failed: ${paired.reason}`);
		const bearer = new Headers({ authorization: `Bearer ${paired.token}` });
		const devicesFile = path.join(stateDir, "devices.json");
		const savedDevicesFile = `${devicesFile}.saved`;
		fs.renameSync(devicesFile, savedDevicesFile);
		fs.mkdirSync(devicesFile);
		try {
			await expect(store.remove(paired.device.id)).rejects.toThrow();
			expect(await store.authenticate(bearer)).toBe(paired.device.id);
		} finally {
			fs.rmSync(devicesFile, { recursive: true, force: true });
			fs.renameSync(savedDevicesFile, devicesFile);
		}
		expect(await store.remove(paired.device.id)).toBe(true);
		expect(await store.authenticate(bearer)).toBeUndefined();
		await store.close();
		store = await DeviceAuthStore.open(stateDir, () => {});
		try {
			expect(await store.authenticate(bearer)).toBeUndefined();
		} finally {
			await store.close();
		}
	});

	it("rejects unauthenticated API operations, push answers, and relay/live/peer upgrades", async () => {
		const t = await startTestDaemon();
		const apiResponses = await Promise.all([
			t.unauthenticated("/api/sessions"),
			t.unauthenticated("/api/sessions/not-a-session/stop", "POST", {}),
			t.unauthenticated("/api/peers/vps/health"),
			t.unauthenticated("/api/push/answer", "POST", { token: "invalid", value: "Allow" }),
			t.unauthenticated("/api/devices"),
			t.unauthenticated("/api/pair/code", "POST", {}),
			t.unauthenticated("/api/devices/not-a-device", "DELETE"),
		]);
		expect(apiResponses.map(response => response.status)).toEqual([401, 401, 401, 401, 401, 401, 401]);

		const upgradeHeaders = {
			Connection: "Upgrade, close",
			Upgrade: "websocket",
			"Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
			"Sec-WebSocket-Version": "13",
		};
		const upgradeResponses = await Promise.all([
			rawRequest(t.daemon.port, "/r/not-a-room", "GET", upgradeHeaders),
			rawRequest(t.daemon.port, "/live/not-a-session", "GET", upgradeHeaders),
			rawRequest(t.daemon.port, "/peers/vps/r/not-a-room", "GET", upgradeHeaders),
		]);
		expect(upgradeResponses.map(response => response.status)).toEqual([401, 401, 401]);
		expect((await t.unauthenticated("/api/setup")).status).toBe(401);
		const status = await t.unauthenticated("/api/pair/status");
		expect(await status.json()).toEqual({ paired: false });
	});

	it("revokes the current device immediately and closes its open relay socket", async () => {
		const t = await startTestDaemon();
		const created = await t.post("/api/sessions", { cwd: t.dir });
		const session = (await created.json()) as { roomId: string };
		const wsBase = t.url.replace(/^http:/, "ws:");
		const host = socket(wsBase, `/r/${session.roomId}?role=host`, { Cookie: t.cookie });
		await waitOpen(host);
		const closed = waitEvent<CloseEvent>(host, "close", "revoked relay closed");

		const devices = (await (await t.get("/api/devices")).json()) as { currentDeviceId: string };
		const revoked = await t.del(`/api/devices/${devices.currentDeviceId}`);
		expect(revoked.status).toBe(200);
		expect(await revoked.json()).toMatchObject({ revoked: devices.currentDeviceId, loggedOut: true });
		expect((await closed).code).toBe(4001);
		expect((await t.unauthenticated("/api/health", "GET", undefined, { Cookie: t.cookie })).status).toBe(401);
		expect(await (await t.get("/api/pair/status", { Cookie: t.cookie })).json()).toEqual({ paired: false });
	});

	it("accepts a worker bearer only until that worker exits", async () => {
		const tokenPath = path.join(makeTmp("omp-console-worker-token-"), "device-token");
		const t = await startTestDaemon({ workerFlags: ["--dump-device-token", tokenPath] });
		const created = await t.post("/api/sessions", { cwd: t.dir });
		const session = (await created.json()) as { id: string };
		for (let attempt = 0; attempt < 100 && !fs.existsSync(tokenPath); attempt++) await Bun.sleep(10);
		const token = fs.readFileSync(tokenPath, "utf8").trim();
		if (process.platform !== "win32") expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);
		expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		const workerRequest = (): Promise<Response> => t.unauthenticated("/api/health", "GET", undefined, { Authorization: `Bearer ${token}` });
		expect((await workerRequest()).status).toBe(200);
		await t.daemon.supervisor.stop(session.id);
		expect((await workerRequest()).status).toBe(401);
	});
});
