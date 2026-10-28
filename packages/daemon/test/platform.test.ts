import { afterEach, describe, expect, it } from "bun:test";
import { startTestDaemon, stopTestDaemons } from "./harness";

afterEach(async () => {
	await stopTestDaemons();
});

describe("platform capabilities", () => {
	it("does not expose computer use on Linux even when configured", async () => {
		const logs: string[] = [];
		const daemon = await startTestDaemon({
			platform: "linux",
			features: {
				librarian: false,
				agenda: false,
				quickAsk: false,
				peers: false,
				openrouterDecisions: false,
				computerUse: true,
				overnight: true,
			},
			log: message => logs.push(message),
		});
		const capabilities = (await (await daemon.get("/api/capabilities")).json()) as { features: { computerUse: boolean } };

		expect(capabilities.features.computerUse).toBe(false);
		expect(logs.filter(message => message.includes("computer use unavailable"))).toEqual([
			"computer use unavailable on linux; computer use is macOS-only",
		]);
	});
});
