import { completeSimple, type AssistantMessage, type Message } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resolveRoleChain } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { roleCandidatePool } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { TextModel, TextRequest } from "./types";

export interface SmolTextModelOptions {
	registry: ModelRegistry;
	settings: Settings;
	sessionId?: string;
}

function textFromContent(content: AssistantMessage["content"]): string {
	return content
		.filter(part => part.type === "text")
		.map(part => part.text)
		.join("")
		.trim();
}

export function createSmolTextModel(options: SmolTextModelOptions): TextModel {
	return {
		async complete(request: TextRequest): Promise<string> {
			const pool = roleCandidatePool("smol", options.settings, options.registry);
			const model = resolveRoleChain("smol", options.settings, pool)[0]?.model;
			if (!model) throw new Error("No model is available for the smol role");

			const apiKey = await options.registry.getApiKey(model, options.sessionId, { signal: request.signal });
			if (request.signal?.aborted) throw new Error("smol text completion aborted");
			if (!apiKey) throw new Error("No credential is available for the smol model");

			const message: Message = { role: "user", content: request.prompt, timestamp: Date.now() };
			const response = await completeSimple(
				model,
				{ systemPrompt: [request.system], messages: [message] },
				{
					apiKey: options.registry.resolver(model, options.sessionId),
					sessionId: options.sessionId,
					maxTokens: request.maxTokens,
					disableReasoning: true,
					signal: request.signal,
				},
			);
			if (response.stopReason === "aborted") throw new Error("smol text completion aborted");
			if (response.stopReason === "error") throw new Error("smol text completion failed");
			const output = textFromContent(response.content);
			if (!output) throw new Error("smol text model returned empty output");
			return output;
		},
	};
}
