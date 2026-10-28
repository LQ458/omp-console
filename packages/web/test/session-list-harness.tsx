import type { CardsResponse, SessionCard, SessionSummary } from "@omp-console/protocol";
import { StrictMode, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { DeckApi } from "../src/lib/api";
import { useUserTitle } from "../src/lib/card-titles";
import { renameCardOptimistically, undoCardTitleOptimistically } from "../src/lib/cards";
import type { SessionCardView } from "../src/lib/cards";
import { HeaderBar, type HeaderControls } from "../src/components/shell/HeaderBar";
import { SessionCardList } from "../src/components/switcher/SessionCardList";
import { WorkspaceProvider, type WorkspaceApi } from "../src/components/workspaces/WorkspaceProvider";
import type { LayoutMode } from "../src/lib/layout";
import "../src/styles/tokens.css";
import "../src/styles/base.css";
import "../src/components/shell/shell.css";
import "../src/components/shell/mobile.css";
import "../src/components/switcher/switcher.css";
import "../src/components/composer/composer.css";
import "./session-list-harness.css";

const SESSION_ID = "session-list-fixture";

function seededSession(sessionId = SESSION_ID, title = "Generated title", waiting = true, saved = true): SessionCardView {
	const now = Date.now();
	const status = waiting ? "waiting" : "unfinished";
	const card: SessionCard = {
		sessionId,
		cwd: "/work/deck-review",
		...(saved ? { sessionFile: `/work/deck-review/${sessionId}.jsonl` } : {}),
		title,
		titleSource: "omp",
		titleHistory: [],
		status,
		stoppedAt: "A saved checkpoint",
		nextStep: "Review the session",
		topic: "Interface",
		scheduled: false,
		live: false,
		lastActivityAt: now,
		stale: false,
	};
	const summary: SessionSummary = {
		id: sessionId,
		title: card.title,
		cwd: card.cwd,
		...(card.sessionFile ? { sessionFile: card.sessionFile } : {}),
		state: waiting ? "asking" : "stopped",
		createdAt: now,
		lastActivityAt: now,
		agentCount: 0,
		goalActive: false,
		awaitingAnswer: waiting,
		...(waiting ? { pendingQuestion: "Approve tool access?" } : {}),
	};
	return { card, summary, live: false, status: card.status };
}

const workspaceApi: WorkspaceApi = {
	async listWorkspaces() {
		return { workspaces: [] };
	},
};

function SessionListHarness(): ReactNode {
	const [cards, setCards] = useState<SessionCardView[]>(() => [
		seededSession(),
		seededSession("session-list-second", "Second session", false),
		seededSession("session-list-unsaved", "Unsaved session", false, false),
	]);
	const cardsRef = useRef(cards);
	cardsRef.current = cards;
	const [titleOverrides, setTitleOverrides] = useState<ReadonlyMap<string, string>>(new Map());
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [openedInNewPane, setOpenedInNewPane] = useState(false);
	const [mode, setMode] = useState<LayoutMode>(() => window.matchMedia("(max-width: 639.98px)").matches ? "phone" : "desktop");

	useEffect(() => {
		const media = window.matchMedia("(max-width: 639.98px)");
		const sync = (): void => setMode(media.matches ? "phone" : "desktop");
		media.addEventListener("change", sync);
		return () => media.removeEventListener("change", sync);
	}, []);

	const saveCard = (updated: SessionCard): void => {
		const next = cardsRef.current.map(view => view.card.sessionId === updated.sessionId ? { ...view, card: updated, status: updated.status } : view);
		cardsRef.current = next;
		setCards(next);
	};
	const [api] = useState<DeckApi>(() => {
		const findCard = (sessionId: string): SessionCard => {
			const view = cardsRef.current.find(candidate => candidate.card.sessionId === sessionId);
			if (!view) throw new Error("Fixture session does not exist.");
			return view.card;
		};
		return {
			async cards(): Promise<CardsResponse> {
				return { cards: cardsRef.current.map(view => view.card), topics: ["Interface"], pending: 0, decisionBackend: "luna" };
			},
			async setCardTitle(sessionId: string, title: string): Promise<SessionCard> {
				const current = findCard(sessionId);
				const updated: SessionCard = {
					...current,
					title,
					titleSource: "user",
					titleHistory: [...current.titleHistory, { title: current.title, source: current.titleSource, at: Date.now() }],
				};
				saveCard(updated);
				return updated;
			},
			async undoCardTitle(sessionId: string): Promise<SessionCard> {
				const current = findCard(sessionId);
				const previous = current.titleHistory.at(-1);
				if (!previous) return current;
				const updated: SessionCard = {
					...current,
					title: previous.title,
					titleSource: previous.source,
					titleHistory: current.titleHistory.slice(0, -1),
				};
				saveCard(updated);
				return updated;
			},
			async extensionUi() {
				return null;
			},
		} as unknown as DeckApi;
	});
	const visibleCards = cards.map(view => {
		const title = titleOverrides.get(view.card.sessionId);
		return title === undefined ? view : { ...view, card: { ...view.card, title } };
	});
	// As in the app: the user's title (shared store) names the pane, else the generated one.
	const headerTitle = useUserTitle(SESSION_ID) ?? "Generated title";
	const headerControls: HeaderControls = {
		api,
		sessionId: SESSION_ID,
		agentId: "root",
		planModeEnabled: null,
		onSetPlanMode: async () => {},
	};
	const selectedSession = (sessionId: string, newPane = false): void => {
		setSelectedId(sessionId);
		setOpenedInNewPane(newPane);
	};
	const archive = (item: SessionCardView): void => {
		const next = cardsRef.current.filter(view => view.card.sessionId !== item.card.sessionId);
		cardsRef.current = next;
		setCards(next);
	};

	return (
		<WorkspaceProvider api={workspaceApi}>
			<main className="session-list-harness" data-opened-session={selectedId ?? ""} data-opened-in-new-pane={openedInNewPane}>
				<HeaderBar
					mode={mode}
					header={null}
					state={null}
					title={headerTitle}
					sessionSummary={null}
					phase="live"
					readOnly={false}
					subCount={0}
					railOpen={false}
					onToggleRail={() => {}}
					onLeave={() => {}}
					controls={headerControls}
				/>
				<aside className="session-list-panel" aria-label="Session list">
					<SessionCardList
						cards={visibleCards}
						topics={["Interface"]}
						health={null}
						selectedId={selectedId}
						busy={false}
						touch={mode === "phone"}
						onSelect={selectedSession}
						onResume={async (session, newPane) => { selectedSession(session.id, newPane); }}
						onFork={() => {}}
						onStop={() => {}}
						onRename={async (sessionId, title) => {
							await renameCardOptimistically(api, sessionId, title, setTitleOverrides, saveCard);
						}}
						onUndoRename={async sessionId => {
							const current = cardsRef.current.find(view => view.card.sessionId === sessionId)?.card;
						const previous = current?.titleHistory.at(-1);
						if (previous) await undoCardTitleOptimistically(api, sessionId, previous.title, setTitleOverrides, saveCard);
						}}
						onArchive={item => archive(item)}
						onArchiveAll={sessionIds => {
							const next = cardsRef.current.filter(view => !sessionIds.includes(view.card.sessionId));
							cardsRef.current = next;
							setCards(next);
						}}
					/>
				</aside>
				<div className="session-list-main" aria-hidden="true" />
			</main>
		</WorkspaceProvider>
	);
}

const root = document.getElementById("root");
if (root === null) throw new Error("Session list harness root is missing.");
createRoot(root).render(<StrictMode><SessionListHarness /></StrictMode>);
