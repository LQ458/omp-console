import { DEFAULT_OVERNIGHT_POLICY } from "@omp-console/protocol";
import type { OvernightTemplate } from "@omp-console/protocol";
import { prompt } from "@oh-my-pi/pi-utils";
import continuationTemplate from "./continuation.md" with { type: "text" };
import defaultTemplate from "./default-template.md" with { type: "text" };
import wrapUpTemplate from "./wrap-up.md" with { type: "text" };

export const DEFAULT_OVERNIGHT_TEMPLATE: OvernightTemplate = {
	prompt: prompt.render(defaultTemplate, {}).trim(),
	policy: { ...DEFAULT_OVERNIGHT_POLICY },
};

export function renderOvernightContinuationPrompt(deadline: string): string {
	return prompt.render(continuationTemplate, { deadline }).trim();
}

export const OVERNIGHT_WRAP_UP_PROMPT = prompt.render(wrapUpTemplate, {}).trim();
