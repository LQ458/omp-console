import type { ReactNode } from "react";
import type { DeckApi } from "../../lib/api";
import { Sheet } from "../shell/Sheet";
import { SetupChecklist } from "./SetupChecklist";

export function SetupSheet({ api, onClose, onStartSession, onOpenExistingSessions }: { api: DeckApi; onClose(): void; onStartSession(): void; onOpenExistingSessions(): void }): ReactNode {
	return (
		<Sheet title="First-run setup" onClose={onClose}>
			<SetupChecklist api={api} onStartSession={onStartSession} onOpenExistingSessions={onOpenExistingSessions} />
		</Sheet>
	);
}
