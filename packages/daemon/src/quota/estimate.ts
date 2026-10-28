import type { SpawnEstimate } from "@omp-console/protocol";
import type { QuotaAgentEvent, QuotaUsageSample } from "./ports";

export interface TokenPercentSample {
	usedPctDelta: number;
	localTokens: number;
}

interface AgentUsage {
	profile?: string;
	complete: boolean;
	models: Map<string, { provider: string; tokens: number }>;
}

export function modelSelector(provider: string, model: string): string {
	return model.includes("/") ? model : `${provider}/${model}`;
}

export function median(values: readonly number[]): number | undefined {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle];
}

/** Least-squares tokens per percentage point through the origin; fewer than ten observations stays hidden. */
export function tokensPerPercentRegression(samples: readonly TokenPercentSample[]): number | undefined {
	if (samples.length < 10) return undefined;
	let numerator = 0;
	let denominator = 0;
	for (const sample of samples) {
		if (
			!Number.isFinite(sample.usedPctDelta) ||
			sample.usedPctDelta <= 0 ||
			!Number.isFinite(sample.localTokens) ||
			sample.localTokens <= 0
		) continue;
		numerator += sample.usedPctDelta * sample.localTokens;
		denominator += sample.usedPctDelta * sample.usedPctDelta;
	}
	if (denominator === 0) return undefined;
	const slope = numerator / denominator;
	return Number.isFinite(slope) && slope > 0 ? slope : undefined;
}

/** Joins per-request usage to omp's agent lifecycle events to estimate completed profile/model spawns. */
export class QuotaEstimator {
	readonly #agents = new Map<string, AgentUsage>();
	readonly #byProfileModel = new Map<string, Map<string, { provider: string; tokens: number }>>();
	readonly #regression = new Map<string, TokenPercentSample[]>();

	recordAgentEvent(sessionId: string, event: QuotaAgentEvent): void {
		const key = `${sessionId}\u0000${event.agentId}`;
		const agent: AgentUsage = this.#agents.get(key) ?? { complete: false, models: new Map<string, { provider: string; tokens: number }>() };
		agent.profile = event.profile;
		if (event.status === "completed" || event.status === "failed" || event.status === "aborted") agent.complete = true;
		this.#agents.set(key, agent);
		if (agent.complete) this.#publishAgent(key, agent);
	}

	recordUsageSample(sessionId: string, sample: QuotaUsageSample): void {
		if (!Number.isFinite(sample.tokens) || sample.tokens < 0 || !Number.isFinite(sample.cacheReadTokens) || sample.cacheReadTokens < 0) return;
		const key = `${sessionId}\u0000${sample.agentId}`;
		const agent: AgentUsage = this.#agents.get(key) ?? { complete: false, models: new Map<string, { provider: string; tokens: number }>() };
		const selector = modelSelector(sample.provider, sample.model);
		const prior = agent.models.get(selector);
		agent.models.set(selector, {
			provider: sample.provider,
			tokens: (prior?.tokens ?? 0) + sample.tokens + sample.cacheReadTokens,
		});
		this.#agents.set(key, agent);
		if (agent.complete) this.#publishAgent(key, agent);
	}

	recordRegression(provider: string, sample: TokenPercentSample): void {
		if (!Number.isFinite(sample.usedPctDelta) || sample.usedPctDelta <= 0 || !Number.isFinite(sample.localTokens) || sample.localTokens <= 0) return;
		const samples = this.#regression.get(provider) ?? [];
		samples.push({ usedPctDelta: sample.usedPctDelta, localTokens: sample.localTokens });
		this.#regression.set(provider, samples);
	}

	tokensPerPercent(provider: string): number | undefined {
		return tokensPerPercentRegression(this.#regression.get(provider) ?? []);
	}

	estimate(profile: string, model: string): SpawnEstimate {
		const key = `${profile}\u0000${model}`;
		const spawns = this.#byProfileModel.get(key);
		if (!spawns || spawns.size === 0) return { samples: 0 };
		const tokens = median([...spawns.values()].map(sample => sample.tokens));
		const provider = [...spawns.values()][0]!.provider;
		const tokensPerPercent = this.tokensPerPercent(provider);
		return {
			samples: spawns.size,
			...(tokens === undefined ? {} : { tokens }),
			...(tokens === undefined || tokensPerPercent === undefined ? {} : { windowPct: tokens / tokensPerPercent }),
		};
	}

	#publishAgent(agentKey: string, agent: AgentUsage): void {
		if (!agent.profile) return;
		for (const [model, value] of agent.models) {
			const groupKey = `${agent.profile}\u0000${model}`;
			const spawns = this.#byProfileModel.get(groupKey) ?? new Map();
			spawns.set(agentKey, value);
			this.#byProfileModel.set(groupKey, spawns);
		}
	}
}
