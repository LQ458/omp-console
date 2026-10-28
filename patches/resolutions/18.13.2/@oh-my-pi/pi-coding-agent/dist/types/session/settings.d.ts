import { type SettingValueOf } from "../config/registry.js";
/** Scope of the resume picker's current-folder list. */
export declare const cfgSessionWorktreeScope: import("../config/registry.js").Setting<"directory" | "repo", "session.worktreeScope">;
export declare const cfgPowerSleepPrevention: import("../config/registry.js").Setting<"display" | "idle" | "off" | "system", "power.sleepPrevention">;
export declare const cfgPrewalkEnabled: import("../config/registry.js").Setting<boolean, "prewalk.enabled">;
export declare const cfgPrewalkAuto: import("../config/registry.js").Setting<"off" | "on" | "suggest", "prewalk.auto">;
export declare const cfgPrewalkAutoTarget: import("../config/registry.js").Setting<string, "prewalk.autoTarget">;
/** Per-provider request limits floored to whole numbers ≥ 1; non-positive or non-numeric entries are dropped. */
export declare function normalizeProviderMaxInFlightRequests(value: unknown): Record<string, number>;
/**
 * Per-provider request limits floored to whole numbers ≥ 1.
 *
 * @throws Error naming every provider whose limit is not a positive number.
 */
export declare function validateProviderMaxInFlightRequests(value: unknown): Record<string, number>;
export declare const cfgProvidersMaxInFlightRequests: import("../config/registry.js").Setting<Record<string, number>, "providers.maxInFlightRequests">;
export declare const cfgImagesDescribeForTextModels: import("../config/registry.js").Setting<boolean, "images.describeForTextModels">;
export declare const cfgDefaultThinkingLevel: import("../config/registry.js").Setting<"auto" | import("@oh-my-pi/pi-catalog/effort").Effort, "defaultThinkingLevel">;
export declare const cfgHideThinkingBlock: import("../config/registry.js").Setting<boolean, "hideThinkingBlock">;
export declare const cfgExpandThinkingBlocks: import("../config/registry.js").Setting<boolean, "expandThinkingBlocks">;
export declare const cfgProseOnlyThinking: import("../config/registry.js").Setting<boolean, "proseOnlyThinking">;
export declare const cfgOmitThinking: import("../config/registry.js").Setting<boolean, "omitThinking">;
export declare const cfgExternalThinking: import("../config/registry.js").Setting<boolean, "externalThinking">;
export declare const cfgModelLoopGuardEnabled: import("../config/registry.js").Setting<boolean, "model.loopGuard.enabled">;
export declare const cfgModelLoopGuardCheckAssistantContent: import("../config/registry.js").Setting<boolean, "model.loopGuard.checkAssistantContent">;
export declare const cfgModelLoopGuardToolCallReminder: import("../config/registry.js").Setting<boolean, "model.loopGuard.toolCallReminder">;
export declare const cfgModelToolCallLoopGuardEnabled: import("../config/registry.js").Setting<boolean, "model.toolCallLoopGuard.enabled">;
export declare const cfgModelToolCallLoopGuardThreshold: import("../config/registry.js").Setting<number, "model.toolCallLoopGuard.threshold">;
export declare const cfgModelToolCallLoopGuardExemptTools: import("../config/registry.js").Setting<string[], "model.toolCallLoopGuard.exemptTools">;
export declare const cfgInlineToolDescriptors: import("../config/registry.js").Setting<"auto" | "off" | "on", "inlineToolDescriptors">;
export declare const cfgIncludeModelInPrompt: import("../config/registry.js").Setting<boolean, "includeModelInPrompt">;
export declare const cfgIncludeWorkspaceTree: import("../config/registry.js").Setting<boolean, "includeWorkspaceTree">;
export declare const cfgSkillful: import("../config/registry.js").Setting<boolean, "skillful">;
/** Personality preset. */
export type Personality = SettingValueOf<typeof cfgPersonality>;
export declare const cfgPersonality: import("../config/registry.js").Setting<"default" | "friendly" | "none" | "pragmatic", "personality">;
export declare const cfgTemperature: import("../config/registry.js").Setting<number, "temperature">;
export declare const cfgTopP: import("../config/registry.js").Setting<number, "topP">;
export declare const cfgTopK: import("../config/registry.js").Setting<number, "topK">;
export declare const cfgMinP: import("../config/registry.js").Setting<number, "minP">;
export declare const cfgPresencePenalty: import("../config/registry.js").Setting<number, "presencePenalty">;
export declare const cfgRepetitionPenalty: import("../config/registry.js").Setting<number, "repetitionPenalty">;
/** Agent sampling options; a negative sampling setting means "provider default" (`undefined`). */
export declare const cfgSampling: import("../config/registry.js").Derived<{
    temperature: number | undefined;
    topP: number | undefined;
    topK: number | undefined;
    minP: number | undefined;
    presencePenalty: number | undefined;
    repetitionPenalty: number | undefined;
    hideThinkingSummary: boolean;
}>;
export declare const cfgTextVerbosity: import("../config/registry.js").Setting<"high" | "low" | "medium", "textVerbosity">;
export declare const cfgTierOpenai: import("../config/registry.js").Setting<"auto" | "default" | "flex" | "none" | "priority" | "scale" | "ultrafast", "tier.openai">;
export declare const cfgTierAnthropic: import("../config/registry.js").Setting<"none" | "priority", "tier.anthropic">;
export declare const cfgTierGoogle: import("../config/registry.js").Setting<"flex" | "none" | "priority", "tier.google">;
export declare const cfgTierSubagent: import("../config/registry.js").Setting<"auto" | "default" | "flex" | "inherit" | "none" | "priority" | "scale" | "ultrafast", "tier.subagent">;
export declare const cfgTierAdvisor: import("../config/registry.js").Setting<"auto" | "default" | "flex" | "inherit" | "none" | "priority" | "scale" | "ultrafast", "tier.advisor">;
export declare const cfgRetryEnabled: import("../config/registry.js").Setting<boolean, "retry.enabled">;
export declare const cfgRetryMaxRetries: import("../config/registry.js").Setting<number, "retry.maxRetries">;
export declare const cfgRetryBaseDelayMs: import("../config/registry.js").Setting<number, "retry.baseDelayMs">;
export declare const cfgRetryMaxDelayMs: import("../config/registry.js").Setting<number, "retry.maxDelayMs">;
export declare const cfgRetryWaitForUsageReset: import("../config/registry.js").Setting<boolean, "retry.waitForUsageReset">;
export declare const cfgRetryModelFallback: import("../config/registry.js").Setting<boolean, "retry.modelFallback">;
export declare const cfgRetryFallbackOn: import("../config/registry.js").Setting<"any" | "except-usage-limit" | "usage-limit", "retry.fallbackOn">;
export declare const cfgRetryUsageAwareFallback: import("../config/registry.js").Setting<boolean, "retry.usageAwareFallback">;
export declare const cfgRetryUsageReservePct: import("../config/registry.js").Setting<number, "retry.usageReservePct">;
export declare const cfgRetryUsageReservePolicy: import("../config/registry.js").Setting<"auto" | "confirm" | "fail-closed", "retry.usageReservePolicy">;
export declare const cfgRetryFallbackChains: import("../config/registry.js").Setting<Record<string, string[]>, "retry.fallbackChains">;
export declare const cfgRetryFallbackRevertPolicy: import("../config/registry.js").Setting<"cooldown-expiry" | "never", "retry.fallbackRevertPolicy">;
/** Retry/backoff and usage-aware fallback policy (`retry.*` except fallback chains/revert policy). */
export declare const cfgRetry: import("../config/registry.js").Derived<import("../config/registry.js").DerivedValues<{
    enabled: import("../config/registry.js").Setting<boolean, "retry.enabled">;
    maxRetries: import("../config/registry.js").Setting<number, "retry.maxRetries">;
    baseDelayMs: import("../config/registry.js").Setting<number, "retry.baseDelayMs">;
    maxDelayMs: import("../config/registry.js").Setting<number, "retry.maxDelayMs">;
    waitForUsageReset: import("../config/registry.js").Setting<boolean, "retry.waitForUsageReset">;
    modelFallback: import("../config/registry.js").Setting<boolean, "retry.modelFallback">;
    fallbackOn: import("../config/registry.js").Setting<"any" | "except-usage-limit" | "usage-limit", "retry.fallbackOn">;
    usageAwareFallback: import("../config/registry.js").Setting<boolean, "retry.usageAwareFallback">;
    usageReservePct: import("../config/registry.js").Setting<number, "retry.usageReservePct">;
    usageReservePolicy: import("../config/registry.js").Setting<"auto" | "confirm" | "fail-closed", "retry.usageReservePolicy">;
}>>;
/** Retry/backoff policy ({@link cfgRetry}). */
export type RetrySettings = SettingValueOf<typeof cfgRetry>;
export declare const cfgProvidersAnthropicServerSideFallback: import("../config/registry.js").Setting<boolean, "providers.anthropic.serverSideFallback">;
/**
 * Anthropic subscription slow mode (`off` | `auto`). Deliberately has no
 * `/settings` UI: `/slow on|off` on an Anthropic model is the only switch.
 * `auto` switches to low priority automatically when a Claude subscription
 * hits its 5-hour limit and Anthropic offers it. Wrap-up allowance tracking
 * runs either way; this only gates the low-priority lane.
 */
export declare const cfgProvidersAnthropicSlowMode: import("../config/registry.js").Setting<"auto" | "off", "providers.anthropic.slowMode">;
export declare const cfgProvidersOllamaCloudMaxConcurrency: import("../config/registry.js").Setting<number, "providers.ollama-cloud.maxConcurrency">;
export declare const cfgProvidersWebSearchTimeoutSeconds: import("../config/registry.js").Setting<number, "providers.webSearchTimeoutSeconds">;
export declare const cfgProvidersAntigravityEndpoint: import("../config/registry.js").Setting<"auto" | "production" | "sandbox", "providers.antigravityEndpoint">;
export declare const cfgProvidersFireworksTier: import("../config/registry.js").Setting<"priority" | "standard", "providers.fireworksTier">;
export declare const cfgProvidersTinyModelDevice: import("../config/registry.js").Setting<"auto" | "coreml" | "cpu" | "cuda" | "default" | "dml" | "gpu" | "metal" | "mlx" | "wasm" | "webgpu" | "webnn" | "webnn-cpu" | "webnn-gpu" | "webnn-npu", "providers.tinyModelDevice">;
export declare const cfgProvidersTinyModelDtype: import("../config/registry.js").Setting<"auto" | "bnb4" | "default" | "fp16" | "fp32" | "int8" | "q1" | "q1f16" | "q2" | "q2f16" | "q4" | "q4f16" | "q8" | "uint8", "providers.tinyModelDtype">;
export declare const cfgProvidersAutoThinkingMaxEffort: import("../config/registry.js").Setting<"max" | "xhigh", "providers.autoThinkingMaxEffort">;
export declare const cfgFeaturesUnexpectedStopDetection: import("../config/registry.js").Setting<"mechanical" | "none" | "smart", "features.unexpectedStopDetection">;
export declare const cfgProvidersKimiApiFormat: import("../config/registry.js").Setting<"anthropic" | "auto" | "openai", "providers.kimiApiFormat">;
export declare const cfgProvidersOpenaiWebsockets: import("../config/registry.js").Setting<"auto" | "off" | "on", "providers.openaiWebsockets">;
export declare const cfgProvidersOpenaiLiveSteering: import("../config/registry.js").Setting<boolean, "providers.openaiLiveSteering">;
export declare const cfgProvidersMuseCodeStoreResponses: import("../config/registry.js").Setting<boolean, "providers.muse-code.storeResponses">;
export declare const cfgProvidersCacheRetention: import("../config/registry.js").Setting<"auto" | "long" | "none" | "short", "providers.cacheRetention">;
export declare const cfgProvidersCacheWarming: import("../config/registry.js").Setting<"idle" | "off" | "streaming", "providers.cacheWarming">;
export declare const cfgProvidersStreamFirstEventTimeoutSeconds: import("../config/registry.js").Setting<number, "providers.streamFirstEventTimeoutSeconds">;
export declare const cfgProvidersStreamIdleTimeoutSeconds: import("../config/registry.js").Setting<number, "providers.streamIdleTimeoutSeconds">;
export declare const cfgProvidersOpenrouterVariant: import("../config/registry.js").Setting<"default" | "exacto" | "floor" | "nitro" | "online", "providers.openrouterVariant">;
export declare const cfgProvidersFetch: import("../config/registry.js").Setting<"auto" | "firecrawl" | "jina" | "lynx" | "native" | "parallel" | "trafilatura", "providers.fetch">;
export declare const cfgCodexResetsAutoRedeem: import("../config/registry.js").Setting<"no" | "unset" | "yes", "codexResets.autoRedeem">;
export declare const cfgCodexResetsMinBlockedMinutes: import("../config/registry.js").Setting<number, "codexResets.minBlockedMinutes">;
export declare const cfgCodexResetsKeepCredits: import("../config/registry.js").Setting<number, "codexResets.keepCredits">;
export declare const cfgCodexResetsSalvageHorizonHours: import("../config/registry.js").Setting<number, "codexResets.salvageHorizonHours">;
/** Codex saved-reset auto-redeem policy (`codexResets.*`). */
export declare const cfgCodexResets: import("../config/registry.js").Derived<import("../config/registry.js").DerivedValues<{
    autoRedeem: import("../config/registry.js").Setting<"no" | "unset" | "yes", "codexResets.autoRedeem">;
    minBlockedMinutes: import("../config/registry.js").Setting<number, "codexResets.minBlockedMinutes">;
    keepCredits: import("../config/registry.js").Setting<number, "codexResets.keepCredits">;
    salvageHorizonHours: import("../config/registry.js").Setting<number, "codexResets.salvageHorizonHours">;
}>>;
/** Whether automatic reset redemption asks first, spends, or remains disabled. */
export type ResetAutoRedeemMode = SettingValueOf<typeof cfgCodexResetsAutoRedeem>;
export declare const cfgClaudeResetsAutoRedeem: import("../config/registry.js").Setting<"no" | "unset" | "yes", "claudeResets.autoRedeem">;
export declare const cfgClaudeResetsMinBlockedMinutes: import("../config/registry.js").Setting<number, "claudeResets.minBlockedMinutes">;
export declare const cfgClaudeResetsKeepCredits: import("../config/registry.js").Setting<number, "claudeResets.keepCredits">;
export declare const cfgClaudeResetsSalvageHorizonHours: import("../config/registry.js").Setting<number, "claudeResets.salvageHorizonHours">;
/** Claude reset auto-redeem policy (`claudeResets.*`), independent of {@link cfgCodexResets}. */
export declare const cfgClaudeResets: import("../config/registry.js").Derived<import("../config/registry.js").DerivedValues<{
    autoRedeem: import("../config/registry.js").Setting<"no" | "unset" | "yes", "claudeResets.autoRedeem">;
    minBlockedMinutes: import("../config/registry.js").Setting<number, "claudeResets.minBlockedMinutes">;
    keepCredits: import("../config/registry.js").Setting<number, "claudeResets.keepCredits">;
    salvageHorizonHours: import("../config/registry.js").Setting<number, "claudeResets.salvageHorizonHours">;
}>>;
export declare const cfgProviderAppendOnlyContext: import("../config/registry.js").Setting<"auto" | "off" | "on", "provider.appendOnlyContext">;
export declare const cfgThinkingBudgetsMinimal: import("../config/registry.js").Setting<number, "thinkingBudgets.minimal">;
export declare const cfgThinkingBudgetsLow: import("../config/registry.js").Setting<number, "thinkingBudgets.low">;
export declare const cfgThinkingBudgetsMedium: import("../config/registry.js").Setting<number, "thinkingBudgets.medium">;
export declare const cfgThinkingBudgetsHigh: import("../config/registry.js").Setting<number, "thinkingBudgets.high">;
export declare const cfgThinkingBudgetsXhigh: import("../config/registry.js").Setting<number, "thinkingBudgets.xhigh">;
export declare const cfgThinkingBudgetsMax: import("../config/registry.js").Setting<number, "thinkingBudgets.max">;
/** Token budget per thinking level (`thinkingBudgets.*`) on transports that accept reasoning token budgets. */
export declare const cfgThinkingBudgets: import("../config/registry.js").Derived<import("../config/registry.js").DerivedValues<{
    minimal: import("../config/registry.js").Setting<number, "thinkingBudgets.minimal">;
    low: import("../config/registry.js").Setting<number, "thinkingBudgets.low">;
    medium: import("../config/registry.js").Setting<number, "thinkingBudgets.medium">;
    high: import("../config/registry.js").Setting<number, "thinkingBudgets.high">;
    xhigh: import("../config/registry.js").Setting<number, "thinkingBudgets.xhigh">;
    max: import("../config/registry.js").Setting<number, "thinkingBudgets.max">;
}>>;
/** Session-tree spend (USD) at which omp warns once; `--warn-cost` overrides it for one run. */
export declare const cfgSessionWarnCost: import("../config/registry.js").Setting<number | undefined, "session.warnCost">;
/** Session-tree spend (USD) at which omp stops sending model requests; `--max-cost` overrides it for one run. */
export declare const cfgSessionMaxCost: import("../config/registry.js").Setting<number | undefined, "session.maxCost">;
