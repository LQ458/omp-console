import { describe, expect, it } from "bun:test";
import { deviceNameFromUserAgent, pairingErrorMessage } from "../src/lib/pairing";

describe("pairing browser labels", () => {
	it("uses a recognizable browser and platform instead of exposing the user agent", () => {
		expect(deviceNameFromUserAgent("Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0")).toBe("Firefox on Linux");
		expect(deviceNameFromUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15")).toBe("Safari on macOS");
		expect(deviceNameFromUserAgent("unknown agent string")).toBe("Web browser");
	});

	it("explains incorrect, expired, and rate-limited pairing attempts", () => {
		expect(pairingErrorMessage(400, "bad-request")).toContain("incorrect");
		expect(pairingErrorMessage(410, "expired")).toContain("expired");
		expect(pairingErrorMessage(429, "rate-limited")).toContain("Wait a minute");
	});
});
