import type { NewSessionBrowseResponse, NewSessionSuggestions, SessionCard, SessionSummary } from "@omp-console/protocol";
import { StrictMode, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { NewSessionPickerProps } from "../src/components/newsession/NewSessionPicker";
import { NewSessionPicker } from "../src/components/newsession/NewSessionPicker";
import { SessionCardList } from "../src/components/switcher/SessionCardList";
import type { SessionCardView } from "../src/lib/cards";
import { Sheet } from "../src/components/shell/Sheet";
import "../src/styles/tokens.css";
import "../src/styles/base.css";
import "../src/components/shell/shell.css";
import "../src/components/shell/mobile.css";
import "../src/components/switcher/switcher.css";
import "../src/components/composer/composer.css";
import { hydrateFigures } from "../src/components/transcript/figures";
import "../src/components/transcript/transcript.css";
import { motionLevel } from "../src/lib/motion";
import "./motion-harness.css";
import { DEFAULT_OVERNIGHT_TEMPLATE } from "../src/lib/overnight";

const pickerApi: NewSessionPickerProps["api"] = {
	async newSessionSuggestions(): Promise<NewSessionSuggestions> {
		return {
			recent: [{ cwd: "/work/motion-demo", name: "motion-demo", sessions30d: 3, lastUsedAt: Date.now() }],
			roots: [{ path: "/work", kind: "project" }],
		};
	},
	async browseNewSession(dir?: string): Promise<NewSessionBrowseResponse> {
		return { dir: dir ?? "/home/alice", home: "/home/alice", entries: [], truncated: false };
	},
	async pathSuggestions() {
		return { matches: [] };
	},
	async getOvernightTemplate() {
		return DEFAULT_OVERNIGHT_TEMPLATE;
	},
	async getOvernightPreflight() {
		return { checks: [] };
	},
};

function sessionCard(sessionId: string): SessionCardView {
	const now = Date.now();
	const card: SessionCard = {
		sessionId,
		cwd: "/work/motion-demo",
		sessionFile: `/work/motion-demo/${sessionId}.jsonl`,
		title: "Motion review session",
		titleSource: "user",
		titleHistory: [],
		status: "done",
		stoppedAt: "Paused at a checkpoint",
		nextStep: "Review the result",
		topic: "Motion",
		scheduled: false,
		live: false,
		lastActivityAt: now,
		stale: false,
	};
	const summary: SessionSummary = {
		id: sessionId,
		title: card.title,
		cwd: card.cwd,
		sessionFile: card.sessionFile,
		state: "stopped",
		createdAt: now,
		lastActivityAt: now,
		agentCount: 0,
		goalActive: false,
		awaitingAnswer: false,
	};
	return { card, summary, live: false, status: "done" };
}

function MotionHarness(): ReactNode {
	// Rows below the archived one must slide up, or the archive scenario never exercises FLIP.
	const [cards, setCards] = useState<SessionCardView[]>(() =>
		["motion-above", "motion-archive", "motion-below-1", "motion-below-2"].map(sessionCard),
	);
	const [pickerOpen, setPickerOpen] = useState(false);
	const [createBusy, setCreateBusy] = useState(false);
	const createTimer = useRef<number | null>(null);
	const [toast, setToast] = useState<"entering" | "leaving" | null>(null);
	const [figureOpen, setFigureOpen] = useState(false);
	const figureRef = useRef<HTMLDivElement | null>(null);

	useEffect(
		() => () => {
			if (createTimer.current !== null) window.clearTimeout(createTimer.current);
		},
		[],
	);
	useEffect(() => {
		if (toast !== "leaving") return;
		const timer = window.setTimeout(() => setToast(null), motionLevel() === "off" ? 0 : 200);
		return () => window.clearTimeout(timer);
	}, [toast]);

	useEffect(() => {
		if (!figureOpen || figureRef.current === null) return;
		hydrateFigures(figureRef.current, true);
	}, [figureOpen]);

	const startCreate = (): void => {
		if (createTimer.current !== null) window.clearTimeout(createTimer.current);
		setCreateBusy(true);
		createTimer.current = window.setTimeout(() => {
			createTimer.current = null;
			setCreateBusy(false);
		}, 1800);
	};

	return (
		<main className="motion-harness">
			<header className="motion-harness-head">
				<h1>Session motion</h1>
				<button type="button" onClick={() => setPickerOpen(true)}>Open session picker</button>
				<button type="button" onClick={() => setFigureOpen(true)}>Show widget figure</button>
				<button type="button" onClick={() => setToast("entering")}>Show archive toast</button>
			</header>
			<SessionCardList
				cards={cards}
				topics={["Motion"]}
				health={null}
				selectedId={null}
				busy={false}
				touch
				onSelect={() => {}}
				onResume={() => {}}
				onFork={() => {}}
				onStop={() => {}}
				onRename={async () => {}}
				onUndoRename={async () => {}}
				onArchive={item => {
					setCards(current => current.filter(row => row.card.sessionId !== item.card.sessionId));
				}}
				onArchiveAll={ids => setCards(current => current.filter(row => !ids.includes(row.card.sessionId)))}
			/>
			{figureOpen && (
				<div ref={figureRef} className="tr-md motion-harness-figure">
					<div
						className="tr-fig tr-fig--widget"
						data-fig="widget"
						data-closed="1"
						data-title="Motion widget"
						data-src={'<button id="run">Run</button><p>Figure card ready.</p>'}
					>
						<pre><code>```widget title="Motion widget"</code></pre>
					</div>
				</div>
			)}
			{toast !== null && (
				<div
					className={`dk-archive-toast sh-toast sh-toast-info${toast === "leaving" ? " is-exiting" : ""}`}
					role="status"
				>
					<span className="sh-toast-msg">Archived “Motion fixture”.</span>
					<button type="button" className="sh-btn sh-btn-icon" aria-label="dismiss archive toast" onClick={() => setToast("leaving")}>
						Dismiss
					</button>
				</div>
			)}
			{pickerOpen && (
				<Sheet title="New session" size="full" onClose={() => setPickerOpen(false)}>
					<NewSessionPicker
						api={pickerApi}
						busy={createBusy}
						actionError={null}
						initialPath={null}
						onCreate={startCreate}
						onClose={() => setPickerOpen(false)}
					/>
				</Sheet>
			)}
		</main>
	);
}

const root = document.getElementById("root");
if (root === null) throw new Error("motion harness root is missing");
createRoot(root).render(
	<StrictMode>
		<MotionHarness />
	</StrictMode>,
);
