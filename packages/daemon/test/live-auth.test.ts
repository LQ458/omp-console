import { describe, expect, it } from "bun:test";
import { checkFetchSite, checkRequest, normalizeAllowedHosts } from "../src/auth";

const config = { owner: "alice@example.com", allowedHosts: normalizeAllowedHosts() };

describe("live websocket access guards", () => {
	it("rejects a non-owner Tailscale identity before live route dispatch", () => {
		const headers = new Headers({ host: "localhost:7481", "Tailscale-User-Login": "mallory@example.com" });
		expect(checkRequest(headers, "127.0.0.1", config)).toEqual({ status: 401, message: "unauthorized" });
	});

	it("blocks browser cross-site upgrades to the live audio endpoint", () => {
		const headers = new Headers({ "sec-fetch-site": "cross-site", upgrade: "websocket" });
		expect(checkFetchSite(headers, "/live/session-1")).toEqual({ status: 403, message: "fetch site not allowed" });
	});
});
