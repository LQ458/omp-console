/**
 * Runs one catalog command from the palette, the composer or the catalog sheet and journals what happened.
 * Remote commands go through `DeckApi.runCommand`; TUI-only ones open an omp console panel or surface the text to copy.
 */
import type { CatalogCommand } from "@omp-console/protocol";
import { type DeckApi, DeckApiError } from "../../lib/api";
import { expectCommandResult } from "../../lib/command-results";
import { recordUsage } from "../../lib/journal";
import {
	type ComposerInsertDetail,
	commandEquivalent,
	insertIntoComposer,
	type OpenPanelDetail,
	openPanel,
	routeCommand,
} from "../../lib/palette";

export type CommandVia = "palette" | "catalog" | "composer";

export type CommandOutcome =
	| { kind: "ran"; text: string }
	| { kind: "filled"; text: string }
	| { kind: "panel"; panel: string; text: string }
	| { kind: "terminal"; text: string; equivalent: string }
	| { kind: "error"; text: string; message: string };

export interface ExecuteDeps {
	api: Pick<DeckApi, "runCommand"> | undefined;
	sessionId: string | undefined;
	via: CommandVia;
	now?: () => number;
	insert?: (detail: ComposerInsertDetail) => void;
	open?: (detail: OpenPanelDetail) => void;
}

/** Journal feature id and `via` for a surface. */
function journalMeta(via: CommandVia): { feature: string; via: "palette" | "catalog" | "composer" } {
	return { feature: via === "catalog" ? "0.1.catalog" : "5.2.palette", via };
}

export function describeCommandError(err: unknown): string {
	if (err instanceof DeckApiError) {
		if (err.kind === "conflict") return "Busy: this command needs an idle session. Wait for the turn to finish.";
		if (err.kind === "bad-request") return "This command cannot run from the app. Use it in the terminal.";
		if (err.kind === "not-found") return "That session is no longer running.";
		return err.message;
	}
	return err instanceof Error ? err.message : "command failed";
}

export async function executeCommand(
	command: CatalogCommand,
	args: string,
	deps: ExecuteDeps,
): Promise<CommandOutcome> {
	const now = deps.now ?? Date.now;
	const insert = deps.insert ?? (detail => insertIntoComposer(detail));
	const open = deps.open ?? (detail => openPanel(detail));
	const meta = journalMeta(deps.via);
	const route = routeCommand(command, args);
	const started = now();
	const note = (action: string, outcome: "ok" | "error"): void =>
		recordUsage({ ...meta, action, outcome, latencyMs: now() - started, detail: command.name });

	switch (route.kind) {
		case "remote": {
			if (deps.api === undefined || deps.sessionId === undefined) {
				note("run", "error");
				return { kind: "error", text: route.text, message: "Connect to a session through the daemon to run commands." };
			}
			// The session host names its result notice after the command as sent (`deck-command:<name>`).
			expectCommandResult(route.text.replace(/^\//, "").split(/\s/, 1)[0] ?? command.name);
			try {
				await deps.api.runCommand(deps.sessionId, route.text);
			} catch (err) {
				note("run", "error");
				return { kind: "error", text: route.text, message: describeCommandError(err) };
			}
			note("run", "ok");
			return { kind: "ran", text: route.text };
		}
		case "fill":
			insert({ text: route.text, atStart: true });
			note("fill", "ok");
			return { kind: "filled", text: route.text };
		case "panel":
			open({ panel: route.panel, command: command.name, args: args.trim() });
			note("panel", "ok");
			return { kind: "panel", panel: route.panel, text: route.text };
		case "terminal":
			note("terminal", "ok");
			return { kind: "terminal", text: route.text, equivalent: commandEquivalent(command, args) };
	}
}
