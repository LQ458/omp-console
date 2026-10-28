import { describe, expect, it } from "bun:test";
import type { QuotaResponse, SpawnEstimate } from "@omp-console/protocol";
import { estimateIsReady, formatResetCountdown, formatSpawnEstimate, moveEquivalentModel, providerReset, quotaTone, validateEquivalenceTable } from "../src/lib/quota";

describe("quota presentation", () => {
	it("uses the amber and red headroom thresholds without rounding across them", () => {
		expect(quotaTone(null)).toBe("unknown");
		expect(quotaTone(40)).toBe("ok");
		expect(quotaTone(39.99)).toBe("warn");
		expect(quotaTone(15)).toBe("warn");
		expect(quotaTone(14.99)).toBe("danger");
	});

	it("formats reset countdowns at seconds, minutes, hours, and days", () => {
		expect(formatResetCountdown(1_000, 0)).toBe("1s");
		expect(formatResetCountdown(61_000, 0)).toBe("1m 1s");
		expect(formatResetCountdown(3_661_000, 0)).toBe("1h 1m");
		expect(formatResetCountdown(90_000_000, 0)).toBe("1d 1h");
		expect(formatResetCountdown(0, 0)).toBe("reset now");
	});

	it("withholds spawn estimates until ten fresh samples and then formats both units", () => {
		const hidden: SpawnEstimate = { tokens: 18_400, windowPct: 1.7, samples: 9 };
		const shown: SpawnEstimate = { ...hidden, samples: 10 };
		expect(estimateIsReady(hidden)).toBe(false);
		expect(formatSpawnEstimate(hidden, "5h")).toBeNull();
		expect(estimateIsReady(shown)).toBe(true);
		expect(formatSpawnEstimate(shown, "5h")).toBe("≈ 18.4k tokens · ~1.7% of 5h");
	});

	it("rejects overlapping roles and repeated fallback models", () => {
		expect(validateEquivalenceTable({ tiers: [] })).toContain("at least one");
		expect(validateEquivalenceTable({ tiers: [{ tier: "default", roles: ["default"], models: [] }, { tier: "judge", roles: ["default"], models: [] }] })).toContain("appears");
		expect(validateEquivalenceTable({ tiers: [{ tier: "default", roles: ["default"], models: ["a", "a"] }] })).toContain("repeats");
		expect(validateEquivalenceTable({ tiers: [{ tier: "judgment", roles: ["judge"], models: [] }] })).toBeNull();
	});
	it("moves fallback models without changing their tier", () => {
		const table = { tiers: [{ tier: "default", roles: ["default"], models: ["a", "b", "c"] }] };
		expect(moveEquivalentModel(table, "default", "b", "up").tiers[0]?.models).toEqual(["b", "a", "c"]);
		expect(moveEquivalentModel(table, "default", "b", "down").tiers[0]?.models).toEqual(["a", "c", "b"]);
	});
});

describe("providerReset", () => {
	const now = 1_000_000;
	const window = (id: string, usedPct: number, inMinutes: number) => ({ id, usedPct, resetsAt: now + inMinutes * 60_000, reservePct: 0 });
	const quota = (accounts: QuotaResponse["accounts"], bindingWindow?: string): QuotaResponse => ({
		accounts,
		providers: [{ provider: "openai-codex", headroomPct: 50, cap: 4, running: 0, queued: 0, state: "ok", ...(bindingWindow ? { bindingWindow } : {}) }],
		equivalence: { tiers: [] },
		cacheWarming: "off",
		updatedAt: now,
	});

	it("reports the binding window's soonest reset on an account that has used it", () => {
		const reset = providerReset(
			quota(
				[
					{ provider: "openai-codex", account: "fresh", windows: [window("5h", 0, 10), window("7d", 5, 30)], fetchedAt: now, stale: false },
					{ provider: "openai-codex", account: "busy", windows: [window("5h", 63, 200), window("7d", 23, 9000)], fetchedAt: now, stale: false },
					{ provider: "openai-codex", account: "old", windows: [window("5h", 90, 5)], fetchedAt: now, stale: true },
				],
				"5h",
			),
			"openai-codex",
			now,
		);
		expect(reset?.window).toBe("5h");
		expect(reset?.resetsAt).toBe(now + 200 * 60_000);
		expect(reset?.details).toContain("busy 5h: 63% used, resets in 3h 20m");
		expect(reset?.details.some(line => line.startsWith("old"))).toBe(false);
	});

	it("falls back to the soonest reset of any window, and to nothing when no reset is known", () => {
		const accounts = [{ provider: "openai-codex", account: "a", windows: [window("7d", 10, 90), window("5h", 10, 40)], fetchedAt: now, stale: false }];
		expect(providerReset(quota(accounts), "OpenAI-Codex", now)?.window).toBe("5h");
		expect(providerReset(quota([{ ...accounts[0]!, windows: [{ id: "5h", usedPct: 10, reservePct: 0 }] }]), "openai-codex", now)).toBeUndefined();
	});
});
