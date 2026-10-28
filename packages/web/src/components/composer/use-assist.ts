import type { CatalogCommand, FileSuggestion, ModelOption } from "@omp-console/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DeckApi } from "../../lib/api";
import { findMentionTrigger, type MentionKind, type MentionTrigger, SuggestionLoader } from "../../lib/mentions";
import { rankCommands, rankModels, withOvernightCommand } from "../../lib/palette";
import { useCatalog } from "../catalog/use-catalog";

const COMMAND_LIMIT = 40;

export type AssistPayload =
	| { kind: "file"; item: FileSuggestion }
	| { kind: "model"; model: ModelOption }
	| { kind: "command"; command: CatalogCommand };

export interface AssistRow {
	key: string;
	primary: string;
	secondary?: string;
	badge?: string;
	disabled?: boolean;
	payload: AssistPayload;
}

export type AssistApi = Pick<DeckApi, "fileSuggestions" | "listModels" | "catalog">;

export interface AssistInput {
	api: AssistApi | undefined;
	sessionId: string | undefined;
	text: string;
	caret: number;
	enabled: boolean;
	overnightEnabled?: boolean;
}

export interface Assist {
	open: boolean;
	trigger: MentionTrigger | null;
	title: string;
	rows: AssistRow[];
	error: string | undefined;
	active: number;
	setActive(index: number): void;
	move(delta: number): void;
	dismiss(): void;
}

const TITLES: Record<MentionKind, string> = { file: "Files", model: "Models for this turn", command: "Commands" };

/**
 * Suggestions for the token under the composer caret: files from the daemon's fuzzy finder (debounced, stale requests
 * aborted), models from `/models`, commands from the session catalog.
 */
export function useAssist({ api, sessionId, text, caret, enabled, overnightEnabled = false }: AssistInput): Assist {
	const usable = enabled && api !== undefined && sessionId !== undefined;
	const found = useMemo(() => (usable ? findMentionTrigger(text, caret) : null), [usable, text, caret]);
	const [dismissed, setDismissed] = useState<string | null>(null);
	const key = found ? `${found.kind}:${found.start}` : null;
	useEffect(() => {
		if (key === null) setDismissed(null);
	}, [key]);
	const trigger = found !== null && key !== dismissed ? found : null;
	const kind = trigger?.kind ?? null;
	const query = trigger?.query ?? "";

	const latest = useRef({ api, sessionId });
	latest.current = { api, sessionId };

	const [files, setFiles] = useState<FileSuggestion[]>([]);
	const [fileError, setFileError] = useState<string | undefined>(undefined);
	const loaderRef = useRef<SuggestionLoader<FileSuggestion[]> | null>(null);
	if (loaderRef.current === null) {
		loaderRef.current = new SuggestionLoader<FileSuggestion[]>({
			load: async (q, signal) => {
				const { api: current, sessionId: id } = latest.current;
				if (current === undefined || id === undefined) return [];
				return (await current.fileSuggestions(id, q, 50, signal)).items;
			},
			onResult: (_q, items) => {
				setFileError(undefined);
				setFiles(items);
			},
			onError: (_q, err) => setFileError(err instanceof Error ? err.message : "file suggestions unavailable"),
		});
	}

	useEffect(() => {
		const loader = loaderRef.current;
		if (loader === null) return;
		if (kind === "file") {
			loader.request(query);
		} else {
			loader.cancel();
			setFiles(prev => (prev.length === 0 ? prev : []));
			setFileError(undefined);
		}
	}, [kind, query, sessionId]);
	useEffect(() => () => loaderRef.current?.cancel(), []);

	const [models, setModels] = useState<ModelOption[] | null>(null);
	const [modelError, setModelError] = useState<string | undefined>(undefined);
	useEffect(() => {
		if (kind !== "model" || models !== null || api === undefined) return;
		let live = true;
		api
			.listModels()
			.then(response => {
				if (live) setModels(response.models);
			})
			.catch((err: unknown) => {
				if (live) setModelError(err instanceof Error ? err.message : "model list unavailable");
			});
		return () => {
			live = false;
		};
	}, [kind, models, api]);

	const { catalog, error: catalogError } = useCatalog(api, sessionId, kind === "command");

	const rows = useMemo<AssistRow[]>(() => {
		if (kind === "file") {
			return files.map(item => ({
				key: item.path,
				primary: item.path,
				badge: item.kind === "dir" ? "dir" : undefined,
				payload: { kind: "file", item },
			}));
		}
		if (kind === "model") {
			return rankModels(models ?? [], query).map(model => ({
				key: model.selector,
				primary: model.selector,
				secondary: model.label,
				badge: model.available ? undefined : "unavailable",
				disabled: !model.available,
				payload: { kind: "model", model },
			}));
		}
		if (kind === "command") {
			return rankCommands(withOvernightCommand(catalog?.commands ?? [], overnightEnabled), query)
				.slice(0, COMMAND_LIMIT)
				.map(({ command }) => ({
					key: `${command.source}:${command.name}`,
					primary: `/${command.name}`,
					secondary: command.description,
					badge: command.remote ? command.source : command.deckControl ? `panel: ${command.deckControl}` : "terminal only",
					payload: { kind: "command", command },
				}));
		}
		return [];
	}, [kind, files, models, catalog, query, overnightEnabled]);

	const [active, setActiveState] = useState(0);
	useEffect(() => {
		setActiveState(0);
	}, [kind, query]);
	const clamped = Math.min(active, Math.max(rows.length - 1, 0));

	const error = kind === "file" ? fileError : kind === "model" ? modelError : kind === "command" ? catalogError : undefined;
	const open = trigger !== null && (rows.length > 0 || error !== undefined);

	const setActive = useCallback((index: number) => setActiveState(index), []);
	const move = useCallback(
		(delta: number) => {
			if (rows.length === 0) return;
			setActiveState((clamped + delta + rows.length) % rows.length);
		},
		[clamped, rows.length],
	);
	const dismiss = useCallback(() => setDismissed(key), [key]);

	return {
		open,
		trigger,
		title: kind === null ? "" : TITLES[kind],
		rows,
		error,
		active: clamped,
		setActive,
		move,
		dismiss,
	};
}
