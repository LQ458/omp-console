import { logger } from "@oh-my-pi/pi-utils";
import { TanCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/tan-command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { SessionOpV3Result } from "@omp-console/protocol";
import { RequestError } from "./request-error";

/** Runs omp's full cloned-session Tan workflow without constructing a TUI. */
export class TanWorkerService {
	readonly #session: AgentSession;
	readonly #settings: Settings;
	readonly #mcpManager: InteractiveModeContext["mcpManager"];

	constructor(options: {
		session: AgentSession;
		settings: Settings;
		mcpManager: InteractiveModeContext["mcpManager"];
	}) {
		this.#session = options.session;
		this.#settings = options.settings;
		this.#mcpManager = options.mcpManager;
	}

	async start(work: string): Promise<Extract<SessionOpV3Result, { agentId: string }>> {
		const trimmedWork = work.trim();
		if (!trimmedWork) throw new RequestError("bad-request", "Usage: /tan <work>");

		let failure: string | undefined;
		const session = this.#session;
		const controller = new TanCommandController({
			session,
			get sessionManager() {
				return session.sessionManager;
			},
			settings: this.#settings,
			mcpManager: this.#mcpManager,
			showStatus: message => logger.debug("tan status", { message }),
			showError: message => {
				failure = message;
				logger.warn("tan dispatch failed", { message });
			},
			rebuildChatFromMessages: () => {},
		});
		const job = await controller.start(trimmedWork);
		if (!job) throw new RequestError("conflict", failure ?? "Tan could not be dispatched.");
		return { ok: true, ...job };
	}
}
