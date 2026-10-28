import type { EquivalenceTable, ProviderFlowView, QuotaResponse, UsageAccountView } from "@omp-console/protocol";
import { EquivalenceStore, substitutesForRole } from "./equivalence";
import { modelSelector, QuotaEstimator, type TokenPercentSample } from "./estimate";
import { QuotaLog } from "./log";
import {
	parseUsageReports,
	providerHeadroom,
	QUOTA_STALE_AFTER_MS,
	withProjections,
	type UsageAccountSnapshot,
} from "./model";
import type {
	CacheWarmingMode,
	QuotaAgentEvent,
	QuotaLiveSession,
	QuotaPorts,
	QuotaRateLimitEvent,
	QuotaUsageSample,
} from "./ports";

const DEFAULT_SPAWN_CAP = 2;
const MAX_SPAWN_CAP = 8;
const CAP_CHANGE_INTERVAL_MS = 10 * 60_000;
const CACHE_LIFETIME_MS = 60 * 60_000;

type WindowPoint = { usedPct: number; fetchedAt: number; resetsAt?: number };
type WindowBurn = { pctPerMin: number; samples: number };
type AccountPoint = { fetchedAt: number; windows: Map<string, WindowPoint> };
type Binding = { snapshot: UsageAccountSnapshot; account: UsageAccountView; window: UsageAccountView["windows"][number] };

interface ProviderControl {
	cap: number;
	freshSamples: number;
	lastCapChangeAt?: number;
	pause?: { accountKey: string; windowId: string; resetsAt?: number; usedPct: number; fetchedAt: number };
	rateLimitUntil?: number;
	rateLimitStatus?: 429 | 529;
	queued: number;
	localTokensAtPoll: number;
	localPollAt?: number;
	localTokensPerMin?: number;
	bindingBaseline?: { accountKey: string; windowId: string; fetchedAt: number; usedPct: number };
	readonly attemptedSwitches: Set<string>;
}

interface ActiveAgent {
	sessionId: string;
	agentId: string;
	parentId?: string;
	provider: string;
	profile: string;
	topLevel: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}
function isCacheWarmingMode(value: unknown): value is CacheWarmingMode {
	return value === "off" || value === "streaming" || value === "idle";
}

function safeAgentEvent(event: QuotaAgentEvent): Record<string, unknown> {
	return {
		agentId: event.agentId,
		...(event.parentId === undefined ? {} : { parentId: event.parentId }),
		profile: event.profile,
		status: event.status,
		...(event.provider === undefined ? {} : { provider: event.provider }),
		...(event.model === undefined ? {} : { model: event.model }),
	};
}

function safeUsageSample(sample: QuotaUsageSample): Record<string, unknown> {
	return {
		agentId: sample.agentId,
		provider: sample.provider,
		model: sample.model,
		tokens: sample.tokens,
		cacheReadTokens: sample.cacheReadTokens,
		at: sample.at,
	};
}

function readAgentEvent(raw: unknown): { sessionId: string; event: QuotaAgentEvent } | undefined {
	if (!isRecord(raw) || !isRecord(raw.event)) return undefined;
	const sessionId = stringField(raw.sessionId);
	const event = raw.event;
	const agentId = stringField(event.agentId);
	const profile = stringField(event.profile);
	const status = event.status;
	if (!sessionId || !agentId || !profile || (status !== "started" && status !== "completed" && status !== "failed" && status !== "aborted")) {
		return undefined;
	}
	const parentId = stringField(event.parentId);
	const provider = stringField(event.provider);
	const model = stringField(event.model);
	return {
		sessionId,
		event: {
			t: "agent",
			agentId,
			profile,
			status,
			...(parentId === undefined ? {} : { parentId }),
			...(provider === undefined ? {} : { provider }),
			...(model === undefined ? {} : { model }),
		},
	};
}

function readUsageSample(raw: unknown): { sessionId: string; sample: QuotaUsageSample } | undefined {
	if (!isRecord(raw) || !isRecord(raw.sample)) return undefined;
	const sessionId = stringField(raw.sessionId);
	const sample = raw.sample;
	const agentId = stringField(sample.agentId);
	const provider = stringField(sample.provider);
	const model = stringField(sample.model);
	if (
		!sessionId ||
		!agentId ||
		!provider ||
		!model ||
		typeof sample.tokens !== "number" ||
		typeof sample.cacheReadTokens !== "number" ||
		typeof sample.at !== "number"
	) return undefined;
	return {
		sessionId,
		sample: {
			t: "usage-sample",
			agentId,
			provider,
			model,
			tokens: sample.tokens,
			cacheReadTokens: sample.cacheReadTokens,
			at: sample.at,
		},
	};
}


function accountWindowKey(accountKey: string, windowId: string): string {
	return `${accountKey}\u0000${windowId}`;
}

export interface QuotaControllerOptions {
	maxConcurrentSpawns?: number;
}

/** Owns quota snapshots, spawn pacing, pause transitions, substitutions, and audit rows. */
export class QuotaController {
	readonly #ports: QuotaPorts;
	readonly #log: QuotaLog;
	readonly #equivalenceStore: EquivalenceStore;
	readonly #estimator = new QuotaEstimator();
	readonly #maxCap: number;
	readonly #providerControls = new Map<string, ProviderControl>();
	readonly #accountPoints = new Map<string, AccountPoint>();
	readonly #windowBurn = new Map<string, WindowBurn>();
	readonly #accounts = new Map<string, UsageAccountSnapshot>();
	readonly #localTokens = new Map<string, number>();
	readonly #activeAgents = new Map<string, ActiveAgent>();
	readonly #liveSessions = new Map<string, QuotaLiveSession>();
	readonly #queueCounts = new Map<string, number>();
	readonly #unsubscribers: Array<() => void> = [];
	#equivalence: EquivalenceTable = { tiers: [] };
	#requestedWarming: CacheWarmingMode = "off";
	#effectiveWarming: CacheWarmingMode = "off";
	#warmupCounts = new Map<string, number>();
	#updatedAt = 0;
	#policySignature = "";
	#events: Promise<unknown> = Promise.resolve();
	#refreshInFlight: Promise<QuotaResponse> | undefined;
	#ready: Promise<void>;
	#initialized = false;
	#eventError: unknown;
	#closed = false;

	constructor(ports: QuotaPorts, stateDir: string, options: QuotaControllerOptions = {}) {
		this.#ports = ports;
		this.#log = new QuotaLog(stateDir);
		this.#equivalenceStore = new EquivalenceStore(stateDir);
		this.#maxCap = Math.max(DEFAULT_SPAWN_CAP, Math.floor(options.maxConcurrentSpawns ?? MAX_SPAWN_CAP));
		this.#unsubscribers.push(
			ports.onUsageSample((sessionId, sample) => this.#schedule(() => this.#recordUsageSample(sessionId, sample))),
			ports.onAgentEvent((sessionId, event) => this.#schedule(() => this.#recordAgentEvent(sessionId, event))),
			ports.onRateLimit(event => this.#schedule(() => this.#recordRateLimit(event))),
			ports.onQueueChange(event => this.#schedule(() => this.#recordQueue(event.provider, event.queued))),
		);
		this.#ready = this.#initialize();
	}

	async refresh(): Promise<QuotaResponse> {
		await this.#ready;
		await this.#events;
		if (this.#eventError !== undefined) {
			const error = this.#eventError;
			this.#eventError = undefined;
			throw error;
		}
		if (this.#refreshInFlight) return this.#refreshInFlight;
		const refresh = this.#refresh();
		this.#refreshInFlight = refresh;
		try {
			return await refresh;
		} finally {
			if (this.#refreshInFlight === refresh) this.#refreshInFlight = undefined;
		}
	}

	async setEquivalence(raw: unknown): Promise<void> {
		await this.#ready;
		this.#equivalence = await this.#equivalenceStore.save(raw);
		await this.#publishPolicy();
	}

	async setCacheWarming(mode: CacheWarmingMode): Promise<void> {
		await this.#ready;
		if (mode !== this.#requestedWarming) {
			await this.#log.append({ type: "cache-warming-request", at: this.#ports.wallNow(), mode });
		}
		this.#requestedWarming = mode;
		await this.#applyWarmingPolicy();
	}

	async estimate(profile: string, model: string) {
		await this.#ready;
		return this.#estimator.estimate(profile, model);
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
		await this.#ready;
		await this.#refreshInFlight?.catch(() => undefined);
		await this.#events;
	}

	async #initialize(): Promise<void> {
		const modelRoles = await this.#ports.getModelRoles();
		this.#equivalence = await this.#equivalenceStore.load(modelRoles);
		const actualWarming = await this.#ports.readCacheWarming();
		let requestedWarming: CacheWarmingMode | undefined;
		for (const row of await this.#log.read()) {
			if (!isRecord(row)) continue;
			if (row.type === "agent") {
				const parsed = readAgentEvent(row);
				if (parsed) this.#estimator.recordAgentEvent(parsed.sessionId, parsed.event);
			} else if (row.type === "usage") {
				const parsed = readUsageSample(row);
				if (parsed) this.#estimator.recordUsageSample(parsed.sessionId, parsed.sample);
			} else if (row.type === "regression" && typeof row.usedPctDelta === "number" && typeof row.localTokens === "number") {
				const provider = stringField(row.provider);
				if (!provider) continue;
				this.#estimator.recordRegression(provider, {
					usedPctDelta: row.usedPctDelta,
					localTokens: row.localTokens,
				});
			} else if (row.type === "cache-warming-request" && isCacheWarmingMode(row.mode)) {
				requestedWarming = row.mode;
			}
		}
		this.#requestedWarming = requestedWarming ?? actualWarming;
		this.#effectiveWarming = actualWarming;
		if (requestedWarming === undefined) {
			await this.#log.append({ type: "cache-warming-request", at: this.#ports.wallNow(), mode: actualWarming });
		}
		this.#initialized = true;
		await this.#publishPolicy(true);
	}

	#schedule(task: () => Promise<void>): void {
		if (this.#closed) return;
		const run = this.#events.then(() => this.#ready).then(task);
		this.#events = run.catch(error => {
			this.#eventError = error;
		});
	}

	async #recordUsageSample(sessionId: string, sample: QuotaUsageSample): Promise<void> {
		if (!Number.isFinite(sample.tokens) || sample.tokens < 0 || !Number.isFinite(sample.cacheReadTokens) || sample.cacheReadTokens < 0) return;
		this.#estimator.recordUsageSample(sessionId, sample);
		const tokens = sample.tokens + sample.cacheReadTokens;
		this.#localTokens.set(sample.provider, (this.#localTokens.get(sample.provider) ?? 0) + tokens);
		if (sample.cacheReadTokens > 0 && sample.tokens <= 1) {
			this.#warmupCounts.set(sample.provider, (this.#warmupCounts.get(sample.provider) ?? 0) + 1);
		}
		const agent = this.#activeAgents.get(`${sessionId}\u0000${sample.agentId}`);
		if (agent) agent.provider = sample.provider;
		await this.#log.append({ type: "usage", at: this.#ports.wallNow(), sessionId, sample: safeUsageSample(sample) });
		await this.#publishPolicy();
	}

	async #recordAgentEvent(sessionId: string, event: QuotaAgentEvent): Promise<void> {
		this.#estimator.recordAgentEvent(sessionId, event);
		const key = `${sessionId}\u0000${event.agentId}`;
		if (event.status === "started") {
			const session = this.#liveSessions.get(sessionId);
			const topLevel = session?.rootAgentId === undefined
				? event.parentId === undefined
				: event.parentId === session.rootAgentId || (event.parentId === undefined && event.agentId !== session.rootAgentId);
			this.#activeAgents.set(key, {
				sessionId,
				agentId: event.agentId,
				...(event.parentId === undefined ? {} : { parentId: event.parentId }),
				provider: event.provider ?? session?.provider ?? "unknown",
				profile: event.profile,
				topLevel,
			});
		} else {
			this.#activeAgents.delete(key);
		}
		await this.#log.append({ type: "agent", at: this.#ports.wallNow(), sessionId, event: safeAgentEvent(event) });
		await this.#publishPolicy();
	}

	async #recordRateLimit(event: QuotaRateLimitEvent): Promise<void> {
		if (!event.provider || !Number.isFinite(event.retryAfterMs)) return;
		const control = this.#control(event.provider);
		control.rateLimitUntil = this.#ports.now() + Math.max(0, event.retryAfterMs);
		control.rateLimitStatus = event.status;
		await this.#log.append({
			type: "rate-limit",
			at: this.#ports.wallNow(),
			provider: event.provider,
			status: event.status,
			retryAfterMs: Math.max(0, event.retryAfterMs),
		});
		await this.#publishPolicy();
	}

	async #recordQueue(provider: string, queued: number): Promise<void> {
		if (!provider || !Number.isFinite(queued)) return;
		this.#queueCounts.set(provider, Math.max(0, Math.floor(queued)));
		this.#control(provider).queued = Math.max(0, Math.floor(queued));
		await this.#publishPolicy();
	}

	async #refresh(): Promise<QuotaResponse> {
		const wallNow = this.#ports.wallNow();
		const sessions = await this.#ports.listLiveSessions();
		const addedSession = sessions.some(session => !this.#liveSessions.has(session.sessionId));
		this.#liveSessions.clear();
		for (const session of sessions) this.#liveSessions.set(session.sessionId, session);
		const reports = await this.#ports.fetchUsage();
		const freshProviders = reports === null ? new Set<string>() : await this.#processReports(reports, wallNow);
		if (reports === null) this.#refreshStaleness(wallNow);
		await this.#updatePauses(freshProviders, wallNow);
		await this.#adjustCaps(freshProviders, wallNow);
		await this.#applyWarmingPolicy(wallNow);
		this.#updatedAt = wallNow;
		await this.#publishPolicy(addedSession);
		return {
			accounts: this.#projectedAccounts(wallNow),
			providers: this.#providerNames().map(provider => this.#flowView(provider, wallNow)),
			equivalence: this.#equivalence,
			cacheWarming: this.#effectiveWarming,
			updatedAt: this.#updatedAt,
		};
	}

	async #processReports(reports: readonly unknown[], wallNow: number): Promise<Set<string>> {
		const parsed = parseUsageReports(reports, wallNow);
		this.#accounts.clear();
		for (const snapshot of parsed) this.#accounts.set(snapshot.key, snapshot);
		const freshProviders = new Set<string>();
		for (const snapshot of parsed) {
			const { view, key } = snapshot;
			const prior = this.#accountPoints.get(key);
			const nextWindows = new Map<string, WindowPoint>();
			let reportChanged = prior === undefined || prior.fetchedAt !== view.fetchedAt;
			for (const window of view.windows) {
				const fetchedAt = snapshot.windowFetchedAt.get(window.id) ?? view.fetchedAt;
				const previous = prior?.windows.get(window.id);
				const point: WindowPoint = { usedPct: window.usedPct, fetchedAt, ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }) };
				nextWindows.set(window.id, point);
				if (view.stale || previous?.fetchedAt === fetchedAt) continue;
				reportChanged = true;
				const burnKey = accountWindowKey(key, window.id);
				if (!previous || previous.resetsAt !== window.resetsAt || fetchedAt <= previous.fetchedAt || window.usedPct < previous.usedPct) {
					this.#windowBurn.set(burnKey, { pctPerMin: 0, samples: 1 });
					continue;
				}
				const priorBurn = this.#windowBurn.get(burnKey);
				const gapMinutes = (fetchedAt - previous.fetchedAt) / 60_000;
				this.#windowBurn.set(burnKey, {
					pctPerMin: (window.usedPct - previous.usedPct) / gapMinutes,
					samples: (priorBurn?.samples ?? 1) + 1,
				});
			}
			if (!view.stale && reportChanged) freshProviders.add(view.provider);
			if (view.stale) continue;
			this.#accountPoints.set(key, { fetchedAt: view.fetchedAt, windows: nextWindows });
		}
		for (const provider of freshProviders) {
			const control = this.#control(provider);
			control.freshSamples += 1;
			await this.#recordRegressionPair(provider);
		}
		if (freshProviders.size > 0) {
			await this.#log.append({
				type: "usage-snapshot",
				at: wallNow,
				accounts: parsed.map(snapshot => snapshot.view),
			});
		}
		return freshProviders;
	}


	async #recordRegressionPair(provider: string): Promise<void> {
		const control = this.#control(provider);
		const binding = this.#bindingFor(provider, this.#ports.wallNow());
		const currentTokens = this.#localTokens.get(provider) ?? 0;
		const localTokens = Math.max(0, currentTokens - control.localTokensAtPoll);
		const previousPollAt = control.localPollAt;
		const priorBaseline = control.bindingBaseline;
		if (binding) {
			const fetchedAt = binding.snapshot.windowFetchedAt.get(binding.window.id) ?? binding.account.fetchedAt;
			if (
				priorBaseline &&
				priorBaseline.accountKey === binding.snapshot.key &&
				priorBaseline.windowId === binding.window.id &&
				fetchedAt > priorBaseline.fetchedAt
			) {
				const usedPctDelta = binding.window.usedPct - priorBaseline.usedPct;
				if (usedPctDelta > 0 && localTokens > 0) {
					const pair: TokenPercentSample = { usedPctDelta, localTokens };
					this.#estimator.recordRegression(provider, pair);
					await this.#log.append({ type: "regression", at: this.#ports.wallNow(), provider, ...pair });
				}
				if (previousPollAt !== undefined && fetchedAt > previousPollAt) {
					const gapMinutes = (fetchedAt - previousPollAt) / 60_000;
					control.localTokensPerMin = localTokens / gapMinutes;
				}
			}
			control.bindingBaseline = {
				accountKey: binding.snapshot.key,
				windowId: binding.window.id,
				fetchedAt,
				usedPct: binding.window.usedPct,
			};
			control.localPollAt = fetchedAt;
		}
		control.localTokensAtPoll = currentTokens;
	}

	#refreshStaleness(wallNow: number): void {
		for (const [key, snapshot] of this.#accounts) {
			const stale = wallNow - snapshot.view.fetchedAt > QUOTA_STALE_AFTER_MS;
			if (stale !== snapshot.view.stale) {
				this.#accounts.set(key, { ...snapshot, view: { ...snapshot.view, stale } });
			}
		}
	}

	async #updatePauses(freshProviders: ReadonlySet<string>, wallNow: number): Promise<void> {
		for (const provider of this.#providerNames()) {
			const control = this.#control(provider);
			const binding = this.#bindingFor(provider, wallNow);
			if (control.pause) {
				if (!freshProviders.has(provider)) continue;
				const pause = control.pause;
				const pausedEntry = this.#projectedEntries(wallNow).find(entry => entry.snapshot.key === pause.accountKey);
				const pausedWindow = pausedEntry?.account.windows.find(window => window.id === pause.windowId);
				if (!pausedEntry || !pausedWindow || pausedEntry.account.stale) continue;
				const fetchedAt = pausedEntry.snapshot.windowFetchedAt.get(pausedWindow.id) ?? pausedEntry.account.fetchedAt;
				const resetSeen = pause.resetsAt !== undefined
					? wallNow >= pause.resetsAt && fetchedAt >= pause.resetsAt && (
						(pausedWindow.resetsAt ?? 0) > pause.resetsAt || pausedWindow.usedPct < pause.usedPct
					)
					: pausedWindow.usedPct < pause.usedPct;
				const headroom = providerHeadroom(this.#projectedAccounts(wallNow).filter(account => account.provider === provider));
				const reserve = this.#bindingFor(provider, wallNow)?.window.reservePct ?? pausedWindow.reservePct;
				if (resetSeen && headroom !== null && headroom > reserve) {
					control.pause = undefined;
					control.attemptedSwitches.clear();
					await this.#logDecision(provider, "quota reset confirmed by a fresh usage poll", control.cap);
				}
				continue;
			}
			if (!binding || 100 - binding.window.usedPct > binding.window.reservePct) continue;
			control.pause = {
				accountKey: binding.snapshot.key,
				windowId: binding.window.id,
				...(binding.window.resetsAt === undefined ? {} : { resetsAt: binding.window.resetsAt }),
				usedPct: binding.window.usedPct,
				fetchedAt: binding.snapshot.windowFetchedAt.get(binding.window.id) ?? binding.account.fetchedAt,
			};
			await this.#switchSessions(provider, control);
			await this.#logDecision(provider, "quota reserve reached", control.cap);
		}
	}

	async #switchSessions(provider: string, control: ProviderControl): Promise<void> {
		for (const session of this.#liveSessions.values()) {
			if (session.provider !== provider || control.attemptedSwitches.has(session.sessionId)) continue;
			control.attemptedSwitches.add(session.sessionId);
			for (const selector of substitutesForRole(
				this.#equivalence,
				session.role,
				modelSelector(session.provider, session.model),
				candidate => this.#ports.getProviderFamily(candidate),
			)) {
				try {
					await this.#ports.setMainModel(session.sessionId, selector);
					break;
				} catch {
					// Only selectors explicitly present in this role's same-or-higher-tier table are considered.
				}
			}
		}
	}

	async #adjustCaps(freshProviders: ReadonlySet<string>, wallNow: number): Promise<void> {
		const now = this.#ports.now();
		for (const provider of freshProviders) {
			const control = this.#control(provider);
			if (control.freshSamples < 3 || control.pause) continue;
			if (control.lastCapChangeAt !== undefined && now - control.lastCapChangeAt < CAP_CHANGE_INTERVAL_MS) continue;
			const binding = this.#bindingFor(provider, wallNow);
			if (!binding || binding.window.projectedPct === undefined) continue;
			const projectedHeadroom = 100 - binding.window.projectedPct;
			const reserve = binding.window.reservePct;
			const next = projectedHeadroom < reserve
				? Math.max(1, Math.floor(control.cap / 2))
				: projectedHeadroom > reserve + 15
					? Math.min(this.#maxCap, control.cap + 1)
					: control.cap;
			if (next === control.cap) continue;
			control.cap = next;
			control.lastCapChangeAt = now;
			await this.#logDecision(provider, `projected end headroom ${projectedHeadroom.toFixed(2)}%`, next);
		}
	}

	async #applyWarmingPolicy(wallNow = this.#ports.wallNow()): Promise<void> {
		const paused = [...this.#providerControls.entries()].filter(([, control]) => control.pause);
		let effective = this.#requestedWarming;
		if (paused.length > 0) {
			const allNearReset = paused.every(([, control]) => {
				const timeToReset = (control.pause?.resetsAt ?? Number.POSITIVE_INFINITY) - wallNow;
				return timeToReset >= 0 && timeToReset <= CACHE_LIFETIME_MS;
			});
			if (!allNearReset) effective = "off";
		}
		if (effective === this.#effectiveWarming) return;
		await this.#ports.writeCacheWarming(effective);
		this.#effectiveWarming = effective;
		await this.#log.append({ type: "cache-warming", at: wallNow, mode: effective, warmups: Object.fromEntries(this.#warmupCounts) });
	}

	async #publishPolicy(force = false): Promise<void> {
		if (!this.#initialized) return;
		const wallNow = this.#ports.wallNow();
		const providers = this.#providerNames().map(provider => {
			const control = this.#control(provider);
			const flow = this.#flowView(provider, wallNow);
			const rateLimited = control.rateLimitUntil !== undefined && control.rateLimitUntil > this.#ports.now();
			return {
				provider,
				admitSpawns: !control.pause && !rateLimited && flow.running < control.cap,
				holdPrompts: Boolean(control.pause) || rateLimited,
				...(flow.reason === undefined ? {} : { reason: flow.reason }),
			};
		});
		const signature = JSON.stringify(providers);
		if (!force && signature === this.#policySignature) return;
		await this.#ports.pushPolicy(providers);
		this.#policySignature = signature;
		await this.#log.append({ type: "policy", at: wallNow, providers });
	}

	#providerNames(): string[] {
		const names = new Set<string>();
		for (const snapshot of this.#accounts.values()) names.add(snapshot.view.provider);
		for (const session of this.#liveSessions.values()) names.add(session.provider);
		for (const agent of this.#activeAgents.values()) if (agent.provider !== "unknown") names.add(agent.provider);
		for (const provider of this.#providerControls.keys()) names.add(provider);
		for (const provider of this.#queueCounts.keys()) names.add(provider);
		return [...names].sort((a, b) => a.localeCompare(b));
	}

	#control(provider: string): ProviderControl {
		let control = this.#providerControls.get(provider);
		if (!control) {
			control = {
				cap: DEFAULT_SPAWN_CAP,
				freshSamples: 0,
				queued: 0,
				localTokensAtPoll: 0,
				attemptedSwitches: new Set(),
			};
			this.#providerControls.set(provider, control);
		}
		return control;
	}

	#projectedEntries(wallNow: number): Array<{ snapshot: UsageAccountSnapshot; account: UsageAccountView }> {
		const snapshots = [...this.#accounts.values()];
		const rates = new Map<string, WindowBurn>();
		for (const snapshot of snapshots) {
			for (const window of snapshot.view.windows) {
				const burn = this.#windowBurn.get(accountWindowKey(snapshot.key, window.id));
				if (burn) rates.set(`${snapshot.view.provider}\u0000${snapshot.view.account}\u0000${window.id}`, burn);
			}
		}
		const accounts = withProjections(snapshots.map(snapshot => snapshot.view), rates, wallNow);
		return snapshots.map((snapshot, index) => ({ snapshot, account: accounts[index]! }));
	}

	#projectedAccounts(wallNow: number): UsageAccountView[] {
		return this.#projectedEntries(wallNow).map(entry => entry.account);
	}

	#bindingFor(provider: string, wallNow: number): Binding | undefined {
		const candidates: Binding[] = [];
		for (const { snapshot, account } of this.#projectedEntries(wallNow)) {
			if (snapshot.view.provider !== provider || account.stale || account.windows.length === 0) continue;
			const window = account.windows.reduce((binding, candidate) => {
				const slack = 100 - candidate.usedPct - candidate.reservePct;
				const bindingSlack = 100 - binding.usedPct - binding.reservePct;
				return slack < bindingSlack ? candidate : binding;
			});
			candidates.push({ snapshot, account, window });
		}
		if (candidates.length === 0) return undefined;
		return candidates.reduce((best, candidate) => {
			const slack = 100 - candidate.window.usedPct - candidate.window.reservePct;
			const bestSlack = 100 - best.window.usedPct - best.window.reservePct;
			return slack > bestSlack ? candidate : best;
		});
	}

	#flowView(provider: string, wallNow: number): ProviderFlowView {
		const control = this.#control(provider);
		const accounts = this.#projectedAccounts(wallNow).filter(account => account.provider === provider);
		const headroomPct = providerHeadroom(accounts);
		const binding = this.#bindingFor(provider, wallNow);
		const running = [...this.#activeAgents.values()].filter(agent => agent.provider === provider && agent.topLevel).length;
		const rateRemaining = control.rateLimitUntil === undefined ? 0 : Math.max(0, control.rateLimitUntil - this.#ports.now());
		const rateLimited = rateRemaining > 0;
		let state: ProviderFlowView["state"];
		let reason: string | undefined;
		if (rateLimited) {
			state = "rate-limited";
			reason = `provider returned ${control.rateLimitStatus ?? 429}; backing off`;
		} else if (headroomPct === null) {
			state = "unknown";
			reason = "usage data is unavailable or older than 10 minutes";
		} else if (control.pause) {
			state = "paused";
			reason = "quota reserve reached; waiting for a fresh reset report";
		} else if (running >= control.cap || control.queued > 0 || (control.freshSamples >= 3 && control.cap < this.#maxCap)) {
			state = "throttled";
			reason = control.queued > 0 ? "spawns are held by flow control" : running >= control.cap ? "top-level subagent cap reached" : "pacing cap reduced";
		} else {
			state = "ok";
		}
		const burn = binding ? this.#windowBurn.get(accountWindowKey(binding.snapshot.key, binding.window.id)) : undefined;
		const tokensPerPercent = this.#estimator.tokensPerPercent(provider);
		const burnLocalPctPerMin = control.localTokensPerMin !== undefined && tokensPerPercent !== undefined
			? control.localTokensPerMin / tokensPerPercent
			: undefined;
		const burnExternalPctPerMin = burn && burn.samples >= 2 && burnLocalPctPerMin !== undefined
			? burn.pctPerMin - burnLocalPctPerMin
			: undefined;
		return {
			provider,
			headroomPct,
			...(binding ? { bindingWindow: binding.window.id } : {}),
			cap: control.cap,
			running,
			queued: control.queued,
			state,
			...(burnLocalPctPerMin === undefined ? {} : { burnLocalPctPerMin }),
			...(burnExternalPctPerMin === undefined ? {} : { burnExternalPctPerMin }),
			...(reason === undefined ? {} : { reason }),
			...(rateLimited ? { resumesAt: wallNow + rateRemaining } : control.pause?.resetsAt === undefined ? {} : { resumesAt: control.pause.resetsAt }),
		};
	}

	async #logDecision(provider: string, reason: string, cap: number): Promise<void> {
		await this.#log.append({
			type: "decision",
			at: this.#ports.wallNow(),
			provider,
			cap,
			reason,
			paused: Boolean(this.#control(provider).pause),
		});
	}
}
