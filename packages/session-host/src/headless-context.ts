/**
 * Structural stand-in for `InteractiveModeContext`: exactly the members `CollabHost` and
 * `CollabController` read or call (collab/host.ts, collab/controller.ts, collab/display-name.ts).
 * Session, session manager, settings and buses are the live objects. Presentation hooks have no
 * display and do nothing; the host's status messages go to the logger instead.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { CollabGuestLink } from "@oh-my-pi/pi-coding-agent/collab/guest";
import type { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

/** The members of `InteractiveModeContext` the collab host stack touches, with presentation narrowed to what is called. */
export interface HeadlessContextShape {
	session: AgentSession;
	sessionManager: SessionManager;
	settings: Settings;
	eventBus?: EventBus;
	subagentEventBus?: EventBus;
	collabHost?: CollabHost;
	collabGuest?: CollabGuestLink;
	statusLine: {
		setCollabStatus(status: unknown): void;
		invalidate(): void;
		getCachedContextBreakdown(): { usedTokens: number; contextWindow: number };
	};
	ui: { requestRender(): void };
	showStatus(message: string): void;
	updatePendingMessagesDisplay(): void;
}

export interface HeadlessContextOptions {
	session: AgentSession;
	settings: Settings;
	eventBus?: EventBus;
	subagentEventBus?: EventBus;
}

/**
 * Context usage reported to guests in `welcome`/`state`. Mirrors the TUI status line, which anchors
 * on `session.getContextUsage()` and reports 0 used tokens while the provider count is unknown.
 */
export function contextBreakdown(session: AgentSession): { usedTokens: number; contextWindow: number } {
	const usage = session.getContextUsage();
	return {
		usedTokens: usage?.tokens ?? 0,
		contextWindow: usage?.contextWindow ?? session.model?.contextWindow ?? 0,
	};
}

export function createHeadlessContext(options: HeadlessContextOptions): HeadlessContextShape {
	const { session, settings, eventBus, subagentEventBus } = options;
	return {
		session,
		// Read through the session on every access: `session.sessionManager` follows /new, fork and switch.
		get sessionManager() {
			return session.sessionManager;
		},
		settings,
		eventBus,
		subagentEventBus,
		collabHost: undefined,
		collabGuest: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => contextBreakdown(session),
		},
		ui: { requestRender: () => {} },
		showStatus: message => logger.debug("collab status", { message }),
		updatePendingMessagesDisplay: () => {},
	};
}

/** The host stack types its context as the full interactive one; this double is verified member by member above. */
export function asInteractiveContext(context: HeadlessContextShape): InteractiveModeContext {
	return context as unknown as InteractiveModeContext;
}
