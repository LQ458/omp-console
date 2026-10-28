/**
 * Titles. Two jobs:
 *
 *  - `{t:"title"}` on every change of the session name, whoever made it: omp's own auto title, `/rename <title>`
 *    (a manual rename through `run-command`), or `refine-title`. The listener follows the session manager, which
 *    `/new`, resume and fork replace.
 *  - `refine-title`: omp's own title generator (`AgentSession.renameTitle`, the call `/rename` without arguments
 *    makes). RPC-style hosts run with `autoTitle` off, so nothing calls the generator unless the daemon asks. The
 *    request is answered once it is admitted; the new title arrives as the `title` line. A title the user set by hand
 *    is never overwritten (omp's `setSessionName("auto")` rule, checked up front so the caller gets a refusal).
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { RequestError } from "./request-error";
import type { StatusSink } from "./status";

const REFINE_TRIGGER = "deck-refine";

export class TitleReporter {
	readonly #session: AgentSession;
	readonly #sink: StatusSink;
	readonly #onChange: () => void;
	#unsubscribe: (() => void) | undefined;
	#lastEmitted: string | undefined;
	#refining: Promise<void> | undefined;
	#disposed = false;

	/** `onChange` runs after a `title` line (the daemon's `state` line carries the title too and must not lag behind). */
	constructor(session: AgentSession, sink: StatusSink, onChange: () => void) {
		this.#session = session;
		this.#sink = sink;
		this.#onChange = onChange;
		this.#lastEmitted = session.sessionManager.getSessionName();
		this.rebind();
	}

	/** Follow the session manager now behind the session (call after `/new`, resume, fork or branch). */
	rebind(): void {
		this.#unsubscribe?.();
		const manager = this.#session.sessionManager;
		this.#unsubscribe = manager.onSessionNameChanged(() => this.#emitIfChanged());
		this.#emitIfChanged();
	}

	#emitIfChanged(): void {
		if (this.#disposed) return;
		const title = this.#session.sessionManager.getSessionName();
		if (title === undefined || title === this.#lastEmitted) return;
		this.#lastEmitted = title;
		this.#sink.emit({ t: "title", title });
		this.#onChange();
	}

	/** Start generating a fresh title; resolves when the work was admitted, the result is the `title` line. */
	refine(): void {
		const session = this.#session;
		const manager = session.sessionManager;
		if (manager.titleSource === "user") {
			throw new RequestError("conflict", "the title was set by the user; rename the session instead");
		}
		if (this.#refining) throw new RequestError("conflict", "a title refinement is already running");
		const sessionId = manager.getSessionId();
		const run = async (): Promise<void> => {
			const title = await session.renameTitle(undefined);
			// A session switch or a newer rename during generation invalidates the result.
			if (title === undefined || session.sessionManager !== manager || manager.getSessionId() !== sessionId) return;
			if (!title) {
				logger.warn("deck title refinement produced no title", { sessionId });
				return;
			}
			if (!(await manager.setSessionName(title, "auto", REFINE_TRIGGER))) {
				logger.debug("deck title refinement not applied", { sessionId });
			}
		};
		this.#refining = run()
			.catch(error => logger.warn("deck title refinement failed", { sessionId, error: String(error) }))
			.finally(() => {
				this.#refining = undefined;
			});
	}

	/** Resolves when a running refinement settled. */
	async settle(): Promise<void> {
		await this.#refining;
	}

	dispose(): void {
		this.#disposed = true;
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
	}
}
