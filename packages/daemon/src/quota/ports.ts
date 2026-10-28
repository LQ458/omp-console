import type { CacheWarmingRequest } from "@omp-console/protocol";
import type { WorkerCommand, WorkerStatus } from "@omp-console/protocol";

export type QuotaUsageSample = Extract<WorkerStatus, { t: "usage-sample" }>;
export type QuotaAgentEvent = Extract<WorkerStatus, { t: "agent" }> & { provider?: string; model?: string };
export type QuotaPolicy = Extract<WorkerCommand, { t: "quota-policy" }>["providers"];
export type CacheWarmingMode = CacheWarmingRequest["mode"];

export interface QuotaLiveSession {
	sessionId: string;
	rootAgentId?: string;
	/** Main agent's model ID; provider is supplied separately. */
	model: string;
	provider: string;
	role: string;
}

/** A provider backoff signal from the worker's actual provider response. */
export interface QuotaRateLimitEvent {
	provider: string;
	status: 429 | 529;
	retryAfterMs: number;
}

/** Current number of spawn requests held by omp's flow-control hook. */
export interface QuotaQueueEvent {
	provider: string;
	queued: number;
}

/** Narrow supervisor/settings boundary used by the quota area. */
export interface QuotaPorts {
	/** Raw omp UsageReports from any live worker, or null when no worker can report usage. */
	fetchUsage(): Promise<unknown[] | null>;
	onUsageSample(listener: (sessionId: string, sample: QuotaUsageSample) => void): () => void;
	onAgentEvent(listener: (sessionId: string, event: QuotaAgentEvent) => void): () => void;
	onRateLimit(listener: (event: QuotaRateLimitEvent) => void): () => void;
	onQueueChange(listener: (event: QuotaQueueEvent) => void): () => void;
	pushPolicy(policy: QuotaPolicy): void | Promise<void>;
	listLiveSessions(): Promise<QuotaLiveSession[]>;
	setMainModel(sessionId: string, selector: string): Promise<void>;
	readCacheWarming(): Promise<CacheWarmingMode>;
	writeCacheWarming(mode: CacheWarmingMode): Promise<void>;
	/** Catalog-derived provider family for a provider/model selector; undefined means no safe match. */
	getProviderFamily(selector: string): string | undefined;
	/** Current omp modelRoles selectors, used to seed the editable equivalence table. */
	getModelRoles(): Promise<Record<string, string>>;
	/** Monotonic milliseconds for throttling decisions. */
	now(): number;
	/** Epoch milliseconds for report age and reset timestamps. */
	wallNow(): number;
}
