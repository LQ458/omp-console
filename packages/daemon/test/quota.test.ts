import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { EquivalenceTable, QuotaResponse } from "@omp-console/protocol";
import {
	accountHeadroom,
	parseUsageReports,
	projectUsedPct,
	providerHeadroom,
	reservePct,
	withProjections,
	QUOTA_STALE_AFTER_MS,
} from "../src/quota/model";
import { defaultEquivalenceTable, EquivalenceValidationError, substitutesForRole, validateEquivalenceTable } from "../src/quota/equivalence";
import { QuotaEstimator, tokensPerPercentRegression } from "../src/quota/estimate";
import { createQuotaRoutes, type QuotaRouteHandler } from "../src/quota/routes";
import type {
	CacheWarmingMode,
	QuotaAgentEvent,
	QuotaLiveSession,
	QuotaPorts,
	QuotaPolicy,
	QuotaQueueEvent,
	QuotaRateLimitEvent,
	QuotaUsageSample,
} from "../src/quota/ports";
import { makeTmp } from "./helpers";

const roots: Array<{ root: string; routes: QuotaRouteHandler }> = [];
const DEFAULT_MODEL_ROLES: Record<string, string> = {
	default: "provider-a/current",
	task: "provider-b/task",
	worker: "provider-a/worker",
	research: "provider-a/research",
	explore: "provider-a/explore",
	judge: "provider-a/judge",
	critic: "provider-a/critic",
	plan: "provider-a/plan",
	escalate: "provider-a/escalate",
	slow: "provider-a/slow",
	lookup: "provider-a/lookup",
	factcheck: "provider-a/factcheck",
	locate: "provider-a/locate",
	fetch: "provider-a/fetch",
	inventory: "provider-a/inventory",
	mechanical: "provider-a/mechanical",
	verify: "provider-a/verify",
	digest: "provider-a/digest",
	smol: "provider-a/smol",
};

afterEach(async () => {
	for (const item of roots.splice(0)) {
		await item.routes.close();
		fs.rmSync(item.root, { recursive: true, force: true });
	}
});

class FakeQuotaPorts implements QuotaPorts {
	reports: unknown[] | null = null;
	sessions: QuotaLiveSession[] = [];
	modelRoles = { ...DEFAULT_MODEL_ROLES };
	monotonic = 10_000;
	wall = Date.UTC(2026, 0, 1);
	cacheMode: CacheWarmingMode = "idle";
	readonly cacheWrites: CacheWarmingMode[] = [];
	readonly policies: QuotaPolicy[] = [];
	readonly modelChanges: Array<{ sessionId: string; selector: string }> = [];
	readonly #usageListeners = new Set<(sessionId: string, sample: QuotaUsageSample) => void>();
	readonly #agentListeners = new Set<(sessionId: string, event: QuotaAgentEvent) => void>();
	readonly #rateListeners = new Set<(event: QuotaRateLimitEvent) => void>();
	readonly #queueListeners = new Set<(event: QuotaQueueEvent) => void>();

	async fetchUsage(): Promise<unknown[] | null> {
		return this.reports;
	}

	onUsageSample(listener: (sessionId: string, sample: QuotaUsageSample) => void): () => void {
		this.#usageListeners.add(listener);
		return () => { this.#usageListeners.delete(listener); };
	}

	onAgentEvent(listener: (sessionId: string, event: QuotaAgentEvent) => void): () => void {
		this.#agentListeners.add(listener);
		return () => { this.#agentListeners.delete(listener); };
	}

	onRateLimit(listener: (event: QuotaRateLimitEvent) => void): () => void {
		this.#rateListeners.add(listener);
		return () => { this.#rateListeners.delete(listener); };
	}

	onQueueChange(listener: (event: QuotaQueueEvent) => void): () => void {
		this.#queueListeners.add(listener);
		return () => { this.#queueListeners.delete(listener); };
	}

	pushPolicy(policy: QuotaPolicy): void {
		this.policies.push(policy.map(entry => ({ ...entry })));
	}

	async listLiveSessions(): Promise<QuotaLiveSession[]> {
		return this.sessions.map(session => ({ ...session }));
	}

	async setMainModel(sessionId: string, selector: string): Promise<void> {
		this.modelChanges.push({ sessionId, selector });
		const session = this.sessions.find(candidate => candidate.sessionId === sessionId);
		if (!session) throw new Error("session disappeared");
		const slash = selector.indexOf("/");
		session.model = selector;
		if (slash > 0) session.provider = selector.slice(0, slash);
	}

	async readCacheWarming(): Promise<CacheWarmingMode> {
		return this.cacheMode;
	}

	async writeCacheWarming(mode: CacheWarmingMode): Promise<void> {
		this.cacheMode = mode;
		this.cacheWrites.push(mode);
	}

	async getModelRoles(): Promise<Record<string, string>> {
		return { ...this.modelRoles };
	}
	getProviderFamily(selector: string): string | undefined {
		const separator = selector.indexOf("/");
		return separator > 0 ? selector.slice(0, separator) : undefined;
	}

	now(): number {
		return this.monotonic;
	}

	wallNow(): number {
		return this.wall;
	}

	advance(ms: number): void {
		this.monotonic += ms;
		this.wall += ms;
	}

	emitUsageSample(sessionId: string, sample: QuotaUsageSample): void {
		for (const listener of this.#usageListeners) listener(sessionId, sample);
	}

	emitAgentEvent(sessionId: string, event: QuotaAgentEvent): void {
		for (const listener of this.#agentListeners) listener(sessionId, event);
	}

	emitRateLimit(event: QuotaRateLimitEvent): void {
		for (const listener of this.#rateListeners) listener(event);
	}

	emitQueueChange(event: QuotaQueueEvent): void {
		for (const listener of this.#queueListeners) listener(event);
	}
}

function makeHarness(maxConcurrentSpawns = 8): { ports: FakeQuotaPorts; routes: QuotaRouteHandler; root: string } {
	const root = makeTmp("omp-console-quota-");
	const ports = new FakeQuotaPorts();
	const routes = createQuotaRoutes(ports, root, { maxConcurrentSpawns });
	roots.push({ root, routes });
	return { ports, routes, root };
}

interface WindowFixture {
	id: string;
	usedPct: number;
	resetsAt?: number;
	modelId?: string;
}

function usageReport(
	provider: string,
	accountId: string,
	label: string,
	fetchedAt: number,
	windows: readonly WindowFixture[],
): unknown {
	return {
		provider,
		fetchedAt,
		metadata: { accountId, account: label },
		limits: windows.map(window => ({
			id: window.id,
			label: window.id,
			scope: { provider, accountId, windowId: window.id, ...(window.modelId ? { modelId: window.modelId } : {}) },
			window: { id: window.id, ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }) },
			amount: { usedFraction: window.usedPct / 100, unit: "percent" },
		})),
	};
}

function singleReport(ports: FakeQuotaPorts, usedPct: number, resetsAt = ports.wallNow() + 2 * 60 * 60_000): unknown {
	return usageReport("provider-a", "account-a", "Example account", ports.wallNow(), [{ id: "5h", usedPct, resetsAt }]);
}

function usageSample(ports: FakeQuotaPorts, overrides: Partial<QuotaUsageSample> = {}): QuotaUsageSample {
	return {
		t: "usage-sample",
		agentId: "main",
		provider: "provider-a",
		model: "current",
		tokens: 100,
		cacheReadTokens: 0,
		at: ports.wallNow(),
		...overrides,
	};
}

function agentEvent(
	agentId: string,
	status: QuotaAgentEvent["status"],
	parentId?: string,
	provider = "provider-a",
): QuotaAgentEvent {
	return {
		t: "agent",
		agentId,
		profile: "worker",
		status,
		provider,
		...(parentId === undefined ? {} : { parentId }),
	};
}

async function callRoute(
	routes: QuotaRouteHandler,
	method: string,
	pathname: string,
	body?: unknown,
): Promise<Response | undefined> {
	const url = new URL(pathname, "http://deck.test");
	return routes(new Request(url.href, {
		method,
		...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
	}), url);
}

async function getQuota(routes: QuotaRouteHandler): Promise<QuotaResponse> {
	const response = await callRoute(routes, "GET", "/api/quota");
	if (!response || response.status !== 200) throw new Error(`quota request failed: ${response?.status ?? "unhandled"}`);
	return await response.json() as QuotaResponse;
}

function flow(response: QuotaResponse, provider: string): QuotaResponse["providers"][number] {
	const result = response.providers.find(entry => entry.provider === provider);
	if (!result) throw new Error(`missing provider flow ${provider}`);
	return result;
}

describe("quota usage model", () => {
	it("uses the tightest account window and the best rotating account for provider headroom", () => {
		const now = 1_800_000_000_000;
		const accounts = parseUsageReports([
			usageReport("anthropic", "a", "A", now, [
				{ id: "5h", usedPct: 60 },
				{ id: "7d", usedPct: 80 },
			]),
			usageReport("anthropic", "b", "B", now, [
				{ id: "5h", usedPct: 20 },
				{ id: "7d", usedPct: 50 },
			]),
		], now).map(snapshot => snapshot.view);

		expect(accounts.map(accountHeadroom)).toEqual([20, 50]);
		expect(providerHeadroom(accounts)).toBe(50);
	});

	it("keeps per-account projections distinct when provider accounts share a label", () => {
		const now = 1_800_000_000_000;
		const accounts = parseUsageReports([
			usageReport("provider-a", "account-a", "Shared", now, [{ id: "5h", usedPct: 10, resetsAt: now + 60_000 }]),
			usageReport("provider-a", "account-b", "Shared", now, [{ id: "5h", usedPct: 10, resetsAt: now + 60_000 }]),
		], now).map(snapshot => snapshot.view);
		const rates = new Map(accounts.map((account, index) => [
			`${account.provider}\u0000${account.account}\u00005h`,
			{ pctPerMin: index + 1, samples: 3 },
		]));
		const projected = withProjections(accounts, rates, now);

		expect(new Set(accounts.map(account => account.account)).size).toBe(2);
		expect(projected.map(account => account.windows[0]?.projectedPct)).toEqual([11, 12]);
	});

	it("marks reports stale after ten minutes and projects a fresh three-sample window", () => {
		const now = 1_800_000_000_000;
		const account = parseUsageReports([
			usageReport("anthropic", "a", "A", now, [{ id: "5h", usedPct: 20, resetsAt: now + 10 * 60_000 }]),
		], now)[0]!.view;
		const projected = withProjections(
			[account],
			new Map([["anthropic\u0000A\u00005h", { pctPerMin: 2, samples: 3 }]]),
			now,
		)[0]!;
		const old = parseUsageReports([
			usageReport("anthropic", "old", "Old", now - QUOTA_STALE_AFTER_MS - 1, [{ id: "5h", usedPct: 10 }]),
		], now)[0]!.view;

		expect(projectUsedPct(20, 2, now + 10 * 60_000, now)).toBe(40);
		expect(projected.windows[0]!.projectedPct).toBe(40);
		expect(projected.windows[0]!.reservePct).toBe(6);
		expect(old.stale).toBe(true);
		expect(providerHeadroom([old])).toBeNull();
	});

	it("decays reserve from ten to two percent over the last twenty minutes", () => {
		const now = 1_800_000_000_000;
		expect(reservePct(now + 25 * 60_000, now)).toBe(10);
		expect(reservePct(now + 10 * 60_000, now)).toBe(6);
		expect(reservePct(now, now)).toBe(2);
	});
});

describe("quota equivalence and estimates", () => {
	it("derives safe default role groups and refuses judgment downgrades", () => {
		const defaults = defaultEquivalenceTable(DEFAULT_MODEL_ROLES);
		expect(defaults.tiers.find(tier => tier.tier === "judgment")?.models).toEqual([]);
		expect(defaults.tiers.find(tier => tier.tier === "build")?.models).toContain("provider-a/current");
		const family = (selector: string) => selector.slice(0, selector.indexOf("/"));
		expect(substitutesForRole(defaults, "judge", "provider-a/judge", family)).toEqual([]);
		const buildAlternatives = substitutesForRole(defaults, "default", "provider-a/current", family);
		const simpleAlternatives = substitutesForRole(defaults, "lookup", "provider-a/lookup", family);
		expect(buildAlternatives).toContain("provider-a/worker");
		expect(buildAlternatives).not.toContain("provider-b/task");
		expect(simpleAlternatives).toContain("provider-a/factcheck");
		expect(simpleAlternatives).not.toContain("provider-a/current");
		expect(() => validateEquivalenceTable({ tiers: [{ tier: "build", roles: ["judge"], models: [] }] })).toThrow(EquivalenceValidationError);
		expect(() => validateEquivalenceTable({ tiers: [{ tier: "build", roles: ["lookup"], models: [] }] })).toThrow(EquivalenceValidationError);
	});

	it("uses completed profile/model spawns for median estimates and hides regression below ten pairs", () => {
		const estimator = new QuotaEstimator();
		const start = (agentId: string): QuotaAgentEvent => ({ ...agentEvent(agentId, "started"), profile: "reviewer" });
		const finish = (agentId: string): QuotaAgentEvent => ({ ...agentEvent(agentId, "completed"), profile: "reviewer" });
		for (const [agentId, tokens] of [["one", 100], ["two", 300]] as const) {
			estimator.recordAgentEvent("session", start(agentId));
			estimator.recordUsageSample("session", usageSample(new FakeQuotaPorts(), {
				agentId,
				model: "model-x",
				tokens,
			}));
			estimator.recordAgentEvent("session", finish(agentId));
		}
		for (let index = 0; index < 9; index++) estimator.recordRegression("provider-a", { usedPctDelta: 1, localTokens: 100 });

		expect(estimator.estimate("reviewer", "provider-a/model-x")).toEqual({ samples: 2, tokens: 200 });
		expect(tokensPerPercentRegression(Array.from({ length: 9 }, () => ({ usedPctDelta: 1, localTokens: 100 })))).toBeUndefined();
		expect(tokensPerPercentRegression(Array.from({ length: 10 }, () => ({ usedPctDelta: 1, localTokens: 100 })))).toBe(100);
	});

	it("validates and persists the editable equivalence table through its route", async () => {
		const { routes } = makeHarness();
		const table: EquivalenceTable = {
			tiers: [
				{ tier: "judgment", roles: ["judge"], models: [] },
				{ tier: "build", roles: ["default"], models: ["provider-a/current", "provider-b/upgrade"] },
			],
		};
		const valid = await callRoute(routes, "PUT", "/api/quota/equivalence", table);
		const afterValid = await getQuota(routes);
		const invalid = await callRoute(routes, "PUT", "/api/quota/equivalence", {
			tiers: [{ tier: "build", roles: ["judge"], models: [] }],
		});

		expect(valid?.status).toBe(204);
		expect(afterValid.equivalence).toEqual(table);
		expect(invalid?.status).toBe(400);
	});
});

describe("quota controller and routes", () => {
	it("chooses the 7d window when it reaches reserve before the 5h window", async () => {
		const { ports, routes } = makeHarness();
		ports.reports = [usageReport("provider-a", "account-a", "Example account", ports.wallNow(), [
			{ id: "5h", usedPct: 50, resetsAt: ports.wallNow() + 5 * 60 * 60_000 },
			{ id: "7d", usedPct: 95, resetsAt: ports.wallNow() + 7 * 24 * 60 * 60_000 },
		])];

		const data = await getQuota(routes);
		const provider = flow(data, "provider-a");

		expect(provider.bindingWindow).toBe("7d");
		expect(provider.headroomPct).toBe(5);
		expect(provider.state).toBe("paused");
	});

	it("keeps the current cap stable when usage becomes stale", async () => {
		const { ports, routes } = makeHarness();
		const resetAt = ports.wallNow() + 2 * 60 * 60_000;
		ports.reports = [singleReport(ports, 10, resetAt)];
		expect(flow(await getQuota(routes), "provider-a").cap).toBe(2);
		expect(flow(await getQuota(routes), "provider-a").cap).toBe(2);
		for (let index = 0; index < 2; index++) {
			ports.advance(60_000);
			ports.reports = [singleReport(ports, 10, resetAt)];
			await getQuota(routes);
		}
		const paced = flow(await getQuota(routes), "provider-a");
		expect(paced.cap).toBe(3);

		ports.advance(QUOTA_STALE_AFTER_MS + 1);
		const stale = flow(await getQuota(routes), "provider-a");
		expect(stale.state).toBe("unknown");
		expect(stale.cap).toBe(3);
	});

	it("halves below projected reserve and waits ten minutes before increasing the cap", async () => {
		const { ports, routes } = makeHarness();
		const resetAt = ports.wallNow() + 60 * 60_000;
		ports.reports = [singleReport(ports, 50, resetAt)];
		await getQuota(routes);
		for (const usedPct of [65, 80]) {
			ports.advance(60_000);
			ports.reports = [singleReport(ports, usedPct, resetAt)];
			await getQuota(routes);
		}
		expect(flow(await getQuota(routes), "provider-a").cap).toBe(1);

		for (const usedPct of [10, 10, 10, 10]) {
			ports.advance(60_000);
			ports.reports = [singleReport(ports, usedPct, resetAt)];
			const result = flow(await getQuota(routes), "provider-a");
			if (ports.monotonic < 10_000 + 10 * 60_000) expect(result.cap).toBe(1);
		}
		expect(flow(await getQuota(routes), "provider-a").cap).toBe(1);
		ports.advance(5 * 60_000);
		ports.reports = [singleReport(ports, 10, resetAt)];
		expect(flow(await getQuota(routes), "provider-a").cap).toBe(1);
		ports.advance(60_000);
		ports.reports = [singleReport(ports, 10, resetAt)];
		expect(flow(await getQuota(routes), "provider-a").cap).toBe(2);
	});

	it("ignores rotation jumps when selecting the binding account", async () => {
		const { ports, routes } = makeHarness();
		const resetAt = ports.wallNow() + 3 * 60 * 60_000;
		ports.reports = [
			usageReport("provider-a", "account-a", "A", ports.wallNow(), [{ id: "5h", usedPct: 20, resetsAt: resetAt }]),
			usageReport("provider-a", "account-b", "B", ports.wallNow(), [{ id: "5h", usedPct: 50, resetsAt: resetAt }]),
		];
		await getQuota(routes);
		ports.advance(60_000);
		ports.reports = [
			usageReport("provider-a", "account-a", "A", ports.wallNow(), [{ id: "5h", usedPct: 95, resetsAt: resetAt }]),
			usageReport("provider-a", "account-b", "B", ports.wallNow(), [{ id: "5h", usedPct: 10, resetsAt: resetAt }]),
		];

		const result = await getQuota(routes);
		const bound = flow(result, "provider-a");
		const selected = result.accounts.find(account => account.account === "B")?.windows[0];
		expect(bound.headroomPct).toBe(90);
		expect(selected?.projectedPct).toBeUndefined();
	});

	it("keeps 429/529 backoff separate from quota pause", async () => {
		const { ports, routes } = makeHarness();
		ports.emitRateLimit({ provider: "provider-a", status: 429, retryAfterMs: 5_000 });
		const limited = flow(await getQuota(routes), "provider-a");
		expect(limited.state).toBe("rate-limited");
		expect(limited.resumesAt).toBe(ports.wallNow() + 5_000);
		expect(ports.policies.at(-1)?.find(entry => entry.provider === "provider-a")?.holdPrompts).toBe(true);

		ports.advance(5_001);
		const expired = flow(await getQuota(routes), "provider-a");
		expect(expired.state).toBe("unknown");
		expect(ports.policies.at(-1)?.find(entry => entry.provider === "provider-a")?.holdPrompts).toBe(false);
	});

	it("switches build sessions only through same-or-higher-tier entries and holds judgment sessions", async () => {
		const { ports, routes } = makeHarness();
		ports.sessions = [
			{ sessionId: "build-session", rootAgentId: "root-build", model: "provider-a/current", provider: "provider-a", role: "default" },
			{ sessionId: "judge-session", rootAgentId: "root-judge", model: "provider-a/judge", provider: "provider-a", role: "judge" },
		];
		ports.reports = [singleReport(ports, 100, ports.wallNow() + 30 * 60_000)];

		const response = await getQuota(routes);
		const provider = flow(response, "provider-a");
		const policy = ports.policies.at(-1)?.find(entry => entry.provider === "provider-a");

		expect(ports.modelChanges).toEqual([{ sessionId: "build-session", selector: "provider-a/worker" }]);
		expect(provider.state).toBe("paused");
		expect(policy?.holdPrompts).toBe(true);
	});

	it("resumes only after a fresh poll confirms reset", async () => {
		const { ports, routes } = makeHarness();
		const resetAt = ports.wallNow() + 60_000;
		ports.reports = [singleReport(ports, 100, resetAt)];
		expect(flow(await getQuota(routes), "provider-a").state).toBe("paused");

		ports.advance(60_000);
		expect(flow(await getQuota(routes), "provider-a").state).toBe("paused");
		ports.reports = [singleReport(ports, 0, ports.wallNow() + 5 * 60 * 60_000)];
		expect(flow(await getQuota(routes), "provider-a").state).toBe("ok");
	});

	it("limits paused cache warming to the final cache lifetime and counts warm-up usage", async () => {
		const { ports, routes, root } = makeHarness();
		const requested = await callRoute(routes, "PUT", "/api/quota/cache-warming", { mode: "streaming" });
		expect(requested?.status).toBe(204);
		const resetAt = ports.wallNow() + 2 * 60 * 60_000;
		ports.reports = [singleReport(ports, 95, resetAt)];
		expect((await getQuota(routes)).cacheWarming).toBe("off");
		expect(ports.cacheWrites).toEqual(["streaming", "off"]);

		ports.emitUsageSample("session", usageSample(ports, { tokens: 1, cacheReadTokens: 100 }));
		ports.advance(70 * 60_000);
		ports.reports = [singleReport(ports, 95, resetAt)];
		const nearReset = await getQuota(routes);
		expect(nearReset.cacheWarming).toBe("streaming");
		expect(ports.cacheWrites).toEqual(["streaming", "off", "streaming"]);
		const rows = (await Bun.file(path.join(root, "quota.jsonl")).text()).trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
		const warming = rows.filter(row => row.type === "cache-warming");
		expect(warming.at(-1)).toMatchObject({ mode: "streaming", warmups: { "provider-a": 1 } });
	});
	it("restores requested cache warming after restarting while quota pause forced it off", async () => {
		const { ports, routes, root } = makeHarness();
		ports.reports = [singleReport(ports, 95, ports.wallNow() + 2 * 60 * 60_000)];
		expect((await getQuota(routes)).cacheWarming).toBe("off");
		await routes.close();

		const restartedPorts = new FakeQuotaPorts();
		restartedPorts.cacheMode = "off";
		restartedPorts.reports = [singleReport(restartedPorts, 20)];
		const restartedRoutes = createQuotaRoutes(restartedPorts, root);
		roots.push({ root, routes: restartedRoutes });

		expect((await getQuota(restartedRoutes)).cacheWarming).toBe("idle");
		expect(restartedPorts.cacheWrites).toEqual(["idle"]);
	});

	it("counts only top-level running agents and exposes held queues", async () => {
		const { ports, routes } = makeHarness(2);
		ports.sessions = [{ sessionId: "session", rootAgentId: "root", model: "provider-a/current", provider: "provider-a", role: "default" }];
		ports.reports = [singleReport(ports, 20)];
		await getQuota(routes);
		ports.emitAgentEvent("session", agentEvent("root", "started"));
		ports.emitAgentEvent("session", agentEvent("first", "started", "root"));
		ports.emitAgentEvent("session", agentEvent("second", "started", "root"));
		ports.emitAgentEvent("session", agentEvent("child", "started", "first"));
		ports.emitQueueChange({ provider: "provider-a", queued: 1 });

		const state = flow(await getQuota(routes), "provider-a");
		expect(state.running).toBe(2);
		expect(state.queued).toBe(1);
		expect(state.state).toBe("throttled");
	});
	it("reapplies and logs provider policy when a live session joins without a quota change", async () => {
		const { ports, routes, root } = makeHarness();
		ports.reports = [singleReport(ports, 20)];
		await getQuota(routes);
		const pushesBeforeJoin = ports.policies.length;
		ports.sessions = [{ sessionId: "new-session", rootAgentId: "root", model: "provider-a/current", provider: "provider-a", role: "default" }];

		await getQuota(routes);
		expect(ports.policies).toHaveLength(pushesBeforeJoin + 1);
		const rows = (await Bun.file(path.join(root, "quota.jsonl")).text()).trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
		const policies = rows.filter(row => row.type === "policy");
		expect(policies.at(-1)?.providers).toEqual([{ provider: "provider-a", admitSpawns: true, holdPrompts: false }]);
	});


	it("learns external burn from ten fresh usage pairs and serves median spawn estimates", async () => {
		const { ports, routes } = makeHarness();
		for (const [agentId, tokens] of [["spawn-one", 100], ["spawn-two", 300]] as const) {
			ports.emitAgentEvent("session", { ...agentEvent(agentId, "started"), profile: "reviewer" });
			ports.emitUsageSample("session", usageSample(ports, { agentId, model: "model-x", tokens }));
			ports.emitAgentEvent("session", { ...agentEvent(agentId, "completed"), profile: "reviewer" });
		}
		const resetAt = ports.wallNow() + 3 * 60 * 60_000;
		ports.reports = [singleReport(ports, 10, resetAt)];
		await getQuota(routes);
		for (let index = 1; index <= 10; index++) {
			ports.emitUsageSample("session", usageSample(ports, { agentId: "local", tokens: 100 }));
			ports.advance(60_000);
			ports.reports = [singleReport(ports, 10 + index, resetAt)];
			await getQuota(routes);
		}

		const response = await callRoute(routes, "GET", "/api/quota/estimate?profile=reviewer&model=provider-a/model-x");
		const estimate = await response!.json() as { tokens?: number; windowPct?: number; samples: number };
		const provider = flow(await getQuota(routes), "provider-a");
		expect(estimate).toEqual({ tokens: 200, windowPct: 2, samples: 2 });
		expect(provider.burnLocalPctPerMin).toBeCloseTo(1);
		expect(provider.burnExternalPctPerMin).toBeCloseTo(0);
	});
});
