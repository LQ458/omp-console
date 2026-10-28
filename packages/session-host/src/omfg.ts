import * as path from "node:path";
import type { OmfgCandidate, SessionOpV3Result } from "@omp-console/protocol";
import { CONFIG_DIR_NAME, prompt } from "@oh-my-pi/pi-utils";
import { invalidate as invalidateCapabilityCache } from "@oh-my-pi/pi-coding-agent/capability";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { fileURLToPath } from "node:url";
import { TtsrToolInspector } from "@oh-my-pi/pi-coding-agent/session/ttsr-outputs";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	buildOmfgRuleForPath,
	extractGeneratedRuleJson,
	historyOutputs,
	parseGeneratedRule,
	validateParsedRuleAgainstAssistantHistory,
	validateRuleAgainstAssistantHistory,
} from "@oh-my-pi/pi-coding-agent/modes/controllers/omfg-rule";
import type { ParsedGeneratedRule } from "@oh-my-pi/pi-coding-agent/modes/controllers/omfg-rule";
import { RequestError } from "./request-error";

// omp does not export its prompt files; read the one OMFG needs from the installed package.
let omfgUserPrompt: Promise<string> | undefined;
function loadOmfgUserPrompt(): Promise<string> {
	omfgUserPrompt ??= Bun.file(
		path.join(
			path.dirname(fileURLToPath(import.meta.resolve("@oh-my-pi/pi-coding-agent"))),
			"prompts/system/omfg-user.md",
		),
	).text();
	return omfgUserPrompt;
}

const MAX_ATTEMPTS = 3;
const MAX_COMPLAINT_LENGTH = 4000;
const MAX_RULE_LENGTH = 64 * 1024;

interface ActiveGeneration {
	requestId: string;
	controller: AbortController;
}

/** Headless OMFG generation and explicit, validated rule acceptance. */
export class OmfgWorkerService {
	readonly #session: AgentSession;
	readonly #settings: Settings;
	readonly #getCwd: () => string;
	readonly #inspector: TtsrToolInspector;
	readonly #candidates = new Map<string, ParsedGeneratedRule>();
	readonly #unvalidatedConfirmation = new Map<string, string>();
	readonly #overwriteConfirmations = new Map<string, { path: string; fileContent: string }>();
	#active: ActiveGeneration | undefined;

	constructor(options: { session: AgentSession; settings: Settings; getCwd(): string }) {
		this.#session = options.session;
		this.#settings = options.settings;
		this.#getCwd = options.getCwd;
		this.#inspector = new TtsrToolInspector(() => options.session.agent.state.tools, this.#getCwd);
	}

	async generate(requestId: string, complaint: string): Promise<Extract<SessionOpV3Result, { candidate: OmfgCandidate }>> {
		const trimmedComplaint = complaint.trim();
		if (!trimmedComplaint) throw new RequestError("bad-request", "Usage: /omfg <complaint>");
		if (trimmedComplaint.length > MAX_COMPLAINT_LENGTH) {
			throw new RequestError("bad-request", `Complaint exceeds ${MAX_COMPLAINT_LENGTH} characters`);
		}
		if (!this.#session.model) throw new RequestError("conflict", "No active model available for /omfg.");
		if (this.#candidates.has(requestId)) throw new RequestError("conflict", "OMFG request id is already in use");

		this.#active?.controller.abort();
		const active: ActiveGeneration = { requestId, controller: new AbortController() };
		this.#active = active;
		try {
			const generated = await this.#generateCandidate(trimmedComplaint, active.controller.signal);
			if (active.controller.signal.aborted || this.#active !== active) {
				throw new RequestError("conflict", "OMFG generation was cancelled");
			}
			this.#candidates.set(requestId, generated.candidate);
			const candidate: OmfgCandidate = {
				requestId,
				name: generated.candidate.rule.name,
				fileContent: generated.candidate.fileContent,
				validated: generated.validated,
				...(generated.validationMessage ? { validationMessage: generated.validationMessage } : {}),
			};
			return { ok: true, candidate };
		} catch (error) {
			if (active.controller.signal.aborted) throw new RequestError("conflict", "OMFG generation was cancelled");
			throw error;
		} finally {
			if (this.#active === active) this.#active = undefined;
		}
	}

	cancel(requestId: string): { ok: true } {
		if (this.#active?.requestId === requestId) {
			this.#active.controller.abort();
			this.#active = undefined;
		}
		this.#candidates.delete(requestId);
		this.#unvalidatedConfirmation.delete(requestId);
		this.#overwriteConfirmations.delete(requestId);
		return { ok: true };
	}

	async save(options: {
		requestId: string;
		fileContent: string;
		scope: "project" | "user";
		overwrite: boolean;
		acceptUnvalidated: boolean;
	}): Promise<Extract<SessionOpV3Result, { save: unknown }>> {
		const candidate = this.#candidates.get(options.requestId);
		if (!candidate) throw new RequestError("not-found", "OMFG candidate is no longer available");
		if (!options.fileContent.trim()) throw new RequestError("bad-request", "Rule content cannot be empty");
		if (options.fileContent.length > MAX_RULE_LENGTH) throw new RequestError("bad-request", "Rule content exceeds 64 KiB");

		const cwd = this.#getCwd();
		const filePath = options.scope === "user"
			? path.join(this.#settings.getAgentDir(), "rules", `${candidate.rule.name}.md`)
			: path.join(cwd, CONFIG_DIR_NAME, "rules", `${candidate.rule.name}.md`);
		if (await Bun.file(filePath).exists()) {
			const confirmation = this.#overwriteConfirmations.get(options.requestId);
			if (!options.overwrite || confirmation?.path !== filePath || confirmation.fileContent !== options.fileContent) {
				this.#overwriteConfirmations.set(options.requestId, { path: filePath, fileContent: options.fileContent });
				return { ok: true, save: { kind: "confirm-overwrite", path: filePath } };
			}
		}

		let rule;
		try {
			rule = buildOmfgRuleForPath(candidate.rule.name, options.fileContent, filePath, options.scope === "user" ? "user" : "project");
		} catch (error) {
			throw new RequestError("bad-request", error instanceof Error ? error.message : String(error));
		}
		const validation = await validateRuleAgainstAssistantHistory(
			rule,
			historyOutputs(this.#session.messages, this.#inspector),
			rule.question !== undefined ? this.#session.ruleJudge() : undefined,
		);
		if (!validation.matched && !options.acceptUnvalidated) {
			this.#unvalidatedConfirmation.set(options.requestId, options.fileContent);
			return {
				ok: true,
				save: {
					kind: "confirm-unvalidated",
					message: validation.feedback ?? "Couldn't confirm this rule matches the conversation.",
				},
			};
		}
		if (!validation.matched && this.#unvalidatedConfirmation.get(options.requestId) !== options.fileContent) {
			throw new RequestError("conflict", "Rule content changed; validate it again before accepting without a history match");
		}

		await Bun.write(filePath, options.fileContent);
		invalidateCapabilityCache(filePath);
		invalidateCapabilityCache(path.dirname(filePath));
		this.#session.ttsrManager?.addRule(rule);
		this.#candidates.delete(options.requestId);
		this.#overwriteConfirmations.delete(options.requestId);
		this.#unvalidatedConfirmation.delete(options.requestId);
		return { ok: true, save: { kind: "saved", path: filePath } };
	}

	close(): void {
		this.#active?.controller.abort();
		this.#active = undefined;
		this.#candidates.clear();
		this.#unvalidatedConfirmation.clear();
		this.#overwriteConfirmations.clear();
	}

	async #generateCandidate(
		complaint: string,
		signal: AbortSignal,
	): Promise<{ candidate: ParsedGeneratedRule; validated: boolean; validationMessage?: string }> {
		const failedAttempts: string[] = [];
		let previousRule: string | undefined;
		let lastCandidate: ParsedGeneratedRule | undefined;
		let lastValidationMessage: string | undefined;

		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			if (signal.aborted) throw new RequestError("conflict", "OMFG generation was cancelled");
			const promptText = prompt.render(await loadOmfgUserPrompt(), {
				complaint,
				feedback: failedAttempts.length > 0 ? failedAttempts.join("\n\n") : undefined,
				previousRule,
			});
			const { replyText } = await this.#session.runEphemeralTurn({ promptText, dedupeReply: false, signal });
			if (signal.aborted) throw new RequestError("conflict", "OMFG generation was cancelled");
			const parsed = parseGeneratedRule(replyText);
			if ("error" in parsed) {
				const failedRule = extractGeneratedRuleJson(replyText) ?? replyText.trim();
				failedAttempts.push(`Attempt ${attempt} failed: invalid rule (${parsed.error}).\nFailed candidate:\n${failedRule}`);
				previousRule = failedRule;
				continue;
			}
			const validation = await validateParsedRuleAgainstAssistantHistory(
				parsed,
				historyOutputs(this.#session.messages, this.#inspector),
				parsed.rule.question !== undefined ? this.#session.ruleJudge() : undefined,
			);
			if (signal.aborted) throw new RequestError("conflict", "OMFG generation was cancelled");
			lastCandidate = validation.candidate;
			if (validation.validation.matched) return { candidate: validation.candidate, validated: true };
			lastValidationMessage = validation.validation.feedback;
			if (validation.validation.judgeUnavailable) {
				return { candidate: validation.candidate, validated: false, validationMessage: lastValidationMessage };
			}
			failedAttempts.push(
				`Attempt ${attempt} failed validation:\n${lastValidationMessage ?? "The rule condition did not match any earlier assistant output."}\nFailed candidate:\n${validation.candidate.fileContent}`,
			);
			previousRule = validation.candidate.fileContent;
		}
		if (!lastCandidate) throw new RequestError("bad-request", "The model did not return a valid TTSR rule.");
		return { candidate: lastCandidate, validated: false, validationMessage: lastValidationMessage };
	}
}
