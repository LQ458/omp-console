import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DeckApi } from "../../lib/api";
import { bindFeedback } from "../../lib/feedback";
import { bindJournal, installJournalLifecycle, journal, recordUsage } from "../../lib/journal";
import { OPEN_PANEL_EVENT, type OpenPanelDetail } from "../../lib/palette";
import { GitPanel } from "../git/GitPanel";
import { RecordPanel } from "../record/RecordPanel";
import { SkillsPanel } from "../skills/SkillsPanel";
import { DebugPanel } from "../debug/DebugPanel";
import { LivePanel } from "../live/LivePanel";
import { CatalogSheet } from "./CatalogSheet";
import { CommandPalette } from "./CommandPalette";
import { TerminalCommandsDialog } from "../terminal/TerminalCommandsDialog";

type RoutedPanel = { detail: OpenPanelDetail; key: number };

export interface DiscoveryHostProps {
	api: DeckApi;
	/** Daemon id of the open session; undefined for a manually joined link (no catalog then). */
	sessionId: string | undefined;
	readOnly: boolean;
	overnightEnabled?: boolean;
}

/**
 * Mounted once per session view: binds the usage journal and feedback to the daemon, owns the Cmd+K palette and the
 * discovery sheets, and routes TUI-only commands to their omp console panels.
 */
export function DiscoveryHost({ api, sessionId, readOnly, overnightEnabled = false }: DiscoveryHostProps): ReactNode {
	const [paletteOpen, setPaletteOpen] = useState(false);
	const [catalogOpen, setCatalogOpen] = useState(false);
	const [terminalPanel, setTerminalPanel] = useState<OpenPanelDetail | null>(null);
	const [routedPanel, setRoutedPanel] = useState<RoutedPanel | null>(null);
	const panelSequence = useRef(0);
	useEffect(() => {
		const unbind = bindJournal(api);
		bindFeedback(api);
		const removeLifecycle = installJournalLifecycle(document, window);
		return () => {
			removeLifecycle();
			void journal.flush();
			unbind();
			bindFeedback(null);
		};
	}, [api]);

	useEffect(() => {
		journal.setContext({ sessionId, screen: "session" });
	}, [sessionId]);

	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") {
				event.preventDefault();
				setPaletteOpen(open => !open);
			}
		};
		const onPanel = (event: Event): void => {
			const detail = (event as CustomEvent<OpenPanelDetail>).detail;
			if (detail?.panel === "catalog") {
				recordUsage({ feature: "0.1.catalog", action: "open", outcome: "ok", via: "direct" });
				setCatalogOpen(true);
				return;
			}
			if (detail && ["tan", "omfg", "cleanse"].includes(detail.panel)) setTerminalPanel(detail);
			if (detail?.panel === "skills" || detail?.panel === "git" || detail?.panel === "record" || detail?.panel === "live" || detail?.panel === "debug") {
				setCatalogOpen(false);
				setRoutedPanel({ detail, key: ++panelSequence.current });
			}
		};
		window.addEventListener("keydown", onKey);
		window.addEventListener(OPEN_PANEL_EVENT, onPanel);
		return () => {
			window.removeEventListener("keydown", onKey);
			window.removeEventListener(OPEN_PANEL_EVENT, onPanel);
		};
	}, []);

	const closePalette = useCallback(() => setPaletteOpen(false), []);
	const closeCatalog = useCallback(() => setCatalogOpen(false), []);
	const closeTerminalPanel = useCallback(() => setTerminalPanel(null), []);
	const closeRoutedPanel = useCallback(() => setRoutedPanel(null), []);
	const openCatalog = useCallback(() => {
		recordUsage({ feature: "0.1.catalog", action: "open", outcome: "ok", via: "palette" });
		setCatalogOpen(true);
	}, []);

	return (
		<>
			{paletteOpen && (
				<CommandPalette api={api} sessionId={sessionId} onClose={closePalette} onOpenCatalog={openCatalog} overnightEnabled={overnightEnabled} />
			)}
			{catalogOpen && <CatalogSheet api={api} sessionId={sessionId} onClose={closeCatalog} overnightEnabled={overnightEnabled} />}
			{terminalPanel && (
				<TerminalCommandsDialog
					key={`${terminalPanel.panel}:${terminalPanel.command ?? ""}:${terminalPanel.args ?? ""}`}
					api={api}
					sessionId={sessionId}
					panel={terminalPanel.panel}
					command={terminalPanel.command}
					args={terminalPanel.args}
					onClose={closeTerminalPanel}
				/>
			)}
			{routedPanel?.detail.panel === "skills" ? <SkillsPanel key={routedPanel.key} api={api} sessionId={sessionId} readOnly={readOnly} command={routedPanel.detail.command} args={routedPanel.detail.args} onClose={closeRoutedPanel} /> : null}
			{routedPanel?.detail.panel === "git" ? <GitPanel key={routedPanel.key} api={api} sessionId={sessionId} readOnly={readOnly} command={routedPanel.detail.command} args={routedPanel.detail.args} onClose={closeRoutedPanel} /> : null}
			{routedPanel?.detail.panel === "record" ? <RecordPanel key={routedPanel.key} onClose={closeRoutedPanel} /> : null}
			{routedPanel?.detail.panel === "live" ? <LivePanel key={routedPanel.key} api={api} sessionId={sessionId} readOnly={readOnly} command={routedPanel.detail.command} onClose={closeRoutedPanel} /> : null}
			{routedPanel?.detail.panel === "debug" ? <DebugPanel key={routedPanel.key} api={api} sessionId={sessionId} readOnly={readOnly} command={routedPanel.detail.command} args={routedPanel.detail.args} onClose={closeRoutedPanel} /> : null}
		</>
	);
}
