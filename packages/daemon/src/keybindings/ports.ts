import type { KeybindingsResponse } from "@omp-console/protocol";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgDoubleEscapeAction } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { getAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";

export interface KeybindingsPorts {
	keybindings(): Promise<KeybindingsResponse>;
}

/** Read omp's resolved keybindings and setting from the agent configuration in `agentDir`. */
export function createKeybindingsPorts(agentDir: string = getAgentDir()): KeybindingsPorts {
	return {
		async keybindings() {
			const settings = await Settings.loadReadOnly({ agentDir });
			const effective = KeybindingsManager.create(agentDir).getEffectiveConfig();
			const bindings: Record<string, string[]> = {};
			for (const [id, keys] of Object.entries(effective)) {
				bindings[id] = keys === undefined ? [] : Array.isArray(keys) ? keys : [keys];
			}
			return { bindings, doubleEscapeAction: cfgDoubleEscapeAction.get(settings) };
		},
	};
}
