import type { NewSessionBrowseResponse, SessionRecipe } from "@omp-console/protocol";
import type { CreateSessionRequest, NewSessionSuggestions, PathSuggestions, StartOvernightRequest, WorkspaceUsage } from "@omp-console/protocol";
import { ChevronDown, ChevronRight, FolderOpen, Home, Moon, Plus } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ActionFeedbackMark, ActionFeedbackMessage } from "../shell/ActionFeedback";
import type { DeckApi } from "../../lib/api";
import { isMachineNetworkError, type Machine } from "../../lib/machines";
import { relTime, shortenPath } from "../../lib/format";
import { basename, isAbsolutePath, isInside, isWindowsPath, pathKey } from "../../lib/native-path";
import type { ActionFeedbackState } from "../../lib/action-feedback";
import { useActionFeedback } from "../../lib/action-feedback";
import { OvernightSetup } from "../overnight/OvernightSetup";
import "../machines/machines.css";
import "./newsession.css";

const LAST_CWD_KEY = "omp-console.lastCwd";
/** The machine the last session was started on, so "VPS" stays picked for the next one. */
const LAST_MACHINE_KEY = "omp-console.newSession.machine";

function readLastMachine(): string | null {
	try {
		return localStorage.getItem(LAST_MACHINE_KEY);
	} catch {
		return null;
	}
}

function saveLastMachine(id: string): void {
	try {
		localStorage.setItem(LAST_MACHINE_KEY, id);
	} catch {
		// Storage is optional in private browsing.
	}
}

export type PickerOption =
	| { kind: "workspace"; workspace: WorkspaceUsage }
	| { kind: "path" | "create"; path: string };

type PathPickerOption = Extract<PickerOption, { kind: "path" | "create" }>;

type PickerApi = Pick<
	DeckApi,
	"newSessionSuggestions" | "browseNewSession" | "pathSuggestions" | "getOvernightTemplate" | "getOvernightPreflight"
> & Partial<Pick<DeckApi, "listRecipes" | "startRecipe">>;

type PickerMachine = Pick<Machine, "id" | "name" | "local" | "reachable"> & {
	api: PickerApi;
};

export interface NewSessionPickerProps {
	api: PickerApi;
	/** Accepted from the existing app.tsx call; project discovery is independent of librarian. */
	librarianEnabled?: boolean;
	overnightEnabled?: boolean;
	machines?: readonly PickerMachine[];
	busy: boolean;
	actionError?: string | null;
	/** A path from `#new=<urlencoded path>`; null means open at recent project folders. */
	initialPath: string | null;
	onCreate(request: CreateSessionRequest, machineId?: string): void;
	onMachineReachable?(machineId: string): void;
	onMachineUnreachable?(machineId: string): void;
	onStartRecipe?(sessionId: string, machineId: string): void;
	onClose(): void;
}

export function pickerIndexAfterMove(index: number, delta: -1 | 1, count: number): number {
	if (count === 0) return -1;
	return (index + delta + count) % count;
}

export function requestForPickerOption(option: PickerOption, model: string): CreateSessionRequest {
	const cwd = option.kind === "workspace" ? option.workspace.cwd : option.path;
	const request: CreateSessionRequest = option.kind === "create" ? { cwd, createDirectory: true } : { cwd };
	if (model.trim() !== "") request.model = model.trim();
	return request;
}
function pickerOptionKey(option: PickerOption): string {
	if (option.kind === "workspace") return `workspace:${pathKey(option.workspace.cwd)}`;
	return `${option.kind}:${pathKey(option.path)}`;
}

function joinFolderPath(directory: string, name: string): string {
	const separator = isWindowsPath(directory) && directory.includes("\\") ? "\\" : "/";
	return `${directory.replace(/[\\/]+$/, "")}${separator}${name}`;
}

export function newSessionBreadcrumbs(home: string, directory: string): Array<{ label: string; path: string }> {
	if (pathKey(home) === pathKey(directory)) return [{ label: "Home", path: home }];
	const windows = isWindowsPath(directory);
	const separator = windows && directory.includes("\\") ? "\\" : "/";
	const segments = (value: string): string[] => value.split(/[\\/]+/).filter(Boolean);
	if (isInside(home, directory)) {
		const relative = directory.slice(home.length).replace(/^[\\/]+/, "");
		let current = home;
		return [
			{ label: "Home", path: home },
			...segments(relative).map(segment => {
				current = joinFolderPath(current, segment);
				return { label: segment, path: current };
			}),
		];
	}

	const parts = segments(directory);
	let root: string;
	let remaining: string[];
	if (windows && directory.startsWith("\\\\") && parts.length >= 2) {
		root = `\\\\${parts[0]}${separator}${parts[1]}`;
		remaining = parts.slice(2);
	} else if (windows && /^[A-Za-z]:[\\/]/.test(directory)) {
		root = `${directory.slice(0, 2)}${separator}`;
		remaining = segments(directory.slice(3));
	} else {
		root = "/";
		remaining = parts;
	}
	let current = root;
	return [
		{ label: root, path: root },
		...remaining.map(segment => {
			current = joinFolderPath(current, segment);
			return { label: segment, path: current };
		}),
	];
}

export function newFolderPath(directory: string, name: string): string {
	return joinFolderPath(directory, name.trim());
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : "The request failed.";
}

function saveLastCwd(cwd: string): void {
	try {
		localStorage.setItem(LAST_CWD_KEY, cwd);
	} catch {
		// Storage is optional in private browsing.
	}
}

export function NewSessionPicker({
	api,
	overnightEnabled: overnightFeatureEnabled = false,
	machines,
	busy,
	actionError,
	initialPath,
	onCreate,
	onMachineReachable,
	onMachineUnreachable,
	onClose,
	onStartRecipe,
}: NewSessionPickerProps): ReactNode {
	const titleId = useId();
	const localMachine = useMemo<PickerMachine>(() => ({ id: "local", name: "Local", api, local: true, reachable: true }), [api]);
	const machineList = useMemo(() => machines ?? [localMachine], [machines, localMachine]);
	const [machineId, setMachineId] = useState<string | null>(readLastMachine);
	const machine =
		machineList.find(item => item.id === machineId && (item.local || item.reachable)) ??
		machineList.find(item => item.local) ??
		localMachine;
	// A remembered machine that is not listed yet (peers still loading) or unreachable falls back to this one without
	// being forgotten: the next picker opens on it again once it is back.
	const wanted = machineList.find(item => item.id === machineId);
	const selectedApi = machine.api;
	const [suggestions, setSuggestions] = useState<NewSessionSuggestions | null>(null);
	const [suggestionError, setSuggestionError] = useState<string | null>(null);
	const [mode, setMode] = useState<"browse" | "paths">(initialPath === null ? "browse" : "paths");
	const [query, setQuery] = useState(initialPath ?? "");
	const [paths, setPaths] = useState<PathSuggestions | null>(null);
	const [pathError, setPathError] = useState<string | null>(null);
	const [model, setModel] = useState("");
	const [overnightEnabled, setOvernightEnabled] = useState(false);
	const [overnightCwd, setOvernightCwd] = useState<string | null>(initialPath);
	const [overnightCreateDirectory, setOvernightCreateDirectory] = useState(false);
	const [activeIndex, setActiveIndex] = useState(0);
	const [browse, setBrowse] = useState<NewSessionBrowseResponse | null>(null);
	const [browseError, setBrowseError] = useState<string | null>(null);
	const [browseLoading, setBrowseLoading] = useState(false);
	const [browseTarget, setBrowseTarget] = useState<string | undefined>();
	const [browseAttempt, setBrowseAttempt] = useState(0);
	const [browseActiveIndex, setBrowseActiveIndex] = useState(0);
	const [browseOpen, setBrowseOpen] = useState(false);
	const [newFolderOpen, setNewFolderOpen] = useState(false);
	const [newFolderName, setNewFolderName] = useState("");
	const rootRef = useRef<HTMLElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const newFolderInputRef = useRef<HTMLInputElement>(null);
	const previousFocusRef = useRef<HTMLElement | null>(null);
	const browseListRef = useRef<HTMLDivElement>(null);
	const recentListRef = useRef<HTMLDivElement>(null);
	const pathOptionsRef = useRef<HTMLDivElement>(null);
	const [suggestionAttempt, setSuggestionAttempt] = useState(0);
	const [pathAttempt, setPathAttempt] = useState(0);
	const [creatingKey, setCreatingKey] = useState<string | null>(null);
	const actionFeedback = useActionFeedback();
	const createObservedBusy = useRef(false);
	const [recipes, setRecipes] = useState<SessionRecipe[]>([]);
	const [recipesError, setRecipesError] = useState<string | null>(null);
	const [recipeStarting, setRecipeStarting] = useState<string | null>(null);
	const recipeStartingRef = useRef<string | null>(null);
	const [recipeStartError, setRecipeStartError] = useState<string | null>(null);
	const [recipeFeedback, setRecipeFeedback] = useState<ActionFeedbackState>("idle");
	const createErrorAtStart = useRef<string | null>(null);
	const recentProjects = useMemo(() => (suggestions?.recent ?? []).slice(0, 6), [suggestions]);
	const browserExpanded = mode === "browse" &&
		(browseOpen || suggestionError !== null || (suggestions !== null && recentProjects.length === 0));
	const canCreateHere = browse !== null &&
		(suggestions?.roots ?? []).some(root => isInside(root.path, browse.dir));
	const cleanNewFolderName = newFolderName.trim();
	const newFolderNameValid = cleanNewFolderName !== "" &&
		cleanNewFolderName !== "." &&
		cleanNewFolderName !== ".." &&
		!/[\\/]/.test(cleanNewFolderName);

	useEffect(() => {
		setSuggestions(null);
		setSuggestionError(null);
		if (!machine.reachable) return;
		const controller = new AbortController();
		void selectedApi
			.newSessionSuggestions(controller.signal)
			.then(result => {
				setSuggestions(result);
				setSuggestionError(null);
				if (!machine.local) onMachineReachable?.(machine.id);
			})
			.catch((error: unknown) => {
				if (!controller.signal.aborted) {
					setSuggestionError("Couldn't load recent projects.");
					if (!machine.local) {
						if (isMachineNetworkError(error)) onMachineUnreachable?.(machine.id);
						else onMachineReachable?.(machine.id);
					}
				}
			});
		return () => controller.abort();
	}, [machine, selectedApi, suggestionAttempt, onMachineReachable, onMachineUnreachable]);

	useEffect(() => {
		setRecipes([]);
		setRecipesError(null);
		if (!machine.reachable) return;
		const listRecipes = selectedApi.listRecipes;
		if (listRecipes === undefined) return;
		const controller = new AbortController();
		void listRecipes.call(selectedApi, controller.signal)
			.then(result => setRecipes(result.recipes))
			.catch((error: unknown) => {
				if (controller.signal.aborted) return;
				setRecipesError(errorText(error));
				if (!machine.local) {
					if (isMachineNetworkError(error)) onMachineUnreachable?.(machine.id);
					else onMachineReachable?.(machine.id);
				}
			});
		return () => controller.abort();
	}, [selectedApi, machine, onMachineReachable, onMachineUnreachable]);
	useEffect(() => {
		if (!browserExpanded) {
			setBrowseLoading(false);
			return;
		}
		if (!machine.reachable) {
			setBrowse(null);
			setBrowseError("This computer isn't reachable. Choose a reachable computer to browse its folders.");
			setBrowseLoading(false);
			return;
		}
		const controller = new AbortController();
		setBrowse(null);
		setBrowseError(null);
		setBrowseLoading(true);
		void selectedApi
			.browseNewSession(browseTarget, controller.signal)
			.then(result => {
				setBrowse(result);
				setBrowseError(null);
				setBrowseActiveIndex(result.entries.length > 0 ? 0 : -1);
				if (!machine.local) onMachineReachable?.(machine.id);
			})
			.catch((error: unknown) => {
				if (!controller.signal.aborted) {
					setBrowseError("Couldn't list this folder.");
					if (!machine.local) {
						if (isMachineNetworkError(error)) onMachineUnreachable?.(machine.id);
						else onMachineReachable?.(machine.id);
					}
				}
			})
			.finally(() => {
				if (!controller.signal.aborted) setBrowseLoading(false);
			});
		return () => controller.abort();
	}, [selectedApi, machine, browserExpanded, browseTarget, browseAttempt, onMachineReachable, onMachineUnreachable]);

	useEffect(() => {
		if (initialPath === null) {
			setMode("browse");
			setQuery("");
			setOvernightCwd(null);
			setOvernightCreateDirectory(false);
			return;
		}
		setMode("paths");
		setQuery(initialPath);
		setOvernightCwd(initialPath);
		setOvernightCreateDirectory(false);
	}, [initialPath]);

	useEffect(() => {
		if (!overnightFeatureEnabled) setOvernightEnabled(false);
	}, [overnightFeatureEnabled]);

	useEffect(() => {
		if (mode !== "paths" || !machine.reachable) {
			setPaths(null);
			setPathError(null);
			return;
		}
		const controller = new AbortController();
		const timer = window.setTimeout(() => {
			void selectedApi
				.pathSuggestions(query, controller.signal)
				.then(result => {
					setPaths(result);
					setPathError(null);
					if (!machine.local) onMachineReachable?.(machine.id);
				})
				.catch((error: unknown) => {
					if (!controller.signal.aborted) {
						setPathError("Couldn't search folders.");
						if (!machine.local) {
							if (isMachineNetworkError(error)) onMachineUnreachable?.(machine.id);
							else onMachineReachable?.(machine.id);
						}
					}
				});
		}, 120);
		return () => {
			window.clearTimeout(timer);
			controller.abort();
		};
	}, [selectedApi, machine, mode, query, pathAttempt, onMachineReachable, onMachineUnreachable]);

	const pathOptions = useMemo<PathPickerOption[]>(() => {
		const typedQuery = query.trim().toLowerCase();
		const recentPaths = recentProjects
			.filter(workspace =>
				typedQuery === "" ||
				(!isAbsolutePath(typedQuery) &&
					!typedQuery.startsWith("~") &&
					(workspace.name.toLowerCase().includes(typedQuery) || workspace.cwd.toLowerCase().includes(typedQuery))),
			)
			.map(workspace => ({ kind: "path" as const, path: workspace.cwd }));
		const matches: PathPickerOption[] = [...recentPaths];
		for (const match of paths?.matches ?? []) {
			if (!matches.some(option => pathKey(option.path) === pathKey(match.path))) matches.push({ kind: "path", path: match.path });
		}
		const typedPath = paths?.typedPath;
		const createPath = paths?.create?.path;
		const typedPathIsCreate = typedPath !== undefined && createPath !== undefined && pathKey(createPath) === pathKey(typedPath);
		if (createPath !== undefined && !typedPathIsCreate) matches.push({ kind: "create", path: createPath });
		if (typedPath !== undefined && !matches.some(option => pathKey(option.path) === pathKey(typedPath))) {
			matches.unshift(typedPathIsCreate ? { kind: "create", path: typedPath } : { kind: "path", path: typedPath });
		}
		// Keep a typed absolute path available even when the directory scan could not find it.
		const rawTyped = query.trim();
		const typed = /^[A-Za-z]:[\\/]+$/.test(rawTyped) ? rawTyped.slice(0, 3) : rawTyped.replace(/[\\/]+$/, "");
		if (isAbsolutePath(rawTyped) && typed.length > 1 && !matches.some(option => pathKey(option.path) === pathKey(typed))) {
			matches.unshift(createPath !== undefined && pathKey(createPath) === pathKey(typed) ? { kind: "create", path: typed } : { kind: "path", path: typed });
		}
		return matches;
	}, [paths, query, recentProjects]);
	const options = useMemo<PickerOption[]>(() => mode === "paths"
		? pathOptions
		: recentProjects.map(workspace => ({ kind: "workspace" as const, workspace })), [mode, pathOptions, recentProjects]);
	useEffect(() => {
		if (overnightCwd !== null) return;
		const suggestedPath = recentProjects[0]?.cwd ?? (mode === "paths" ? paths?.matches[0]?.path : undefined);
		if (suggestedPath !== undefined) setOvernightCwd(suggestedPath);
	}, [mode, overnightCwd, paths, recentProjects]);

	useEffect(() => {
		setActiveIndex(options.length > 0 ? 0 : -1);
	}, [options]);
	useEffect(() => {
		if (creatingKey === null) return;
		if (busy) {
			createObservedBusy.current = true;
			// The switcher clears its error when the create starts: any error after that is this attempt's, even when its
			// text matches an earlier failure.
			if (actionError == null) createErrorAtStart.current = null;
			return;
		}
		if (!createObservedBusy.current) {
			if (actionError != null && actionError !== createErrorAtStart.current) {
				actionFeedback.fail(new Error(actionError));
			}
			return;
		}
		createObservedBusy.current = false;
		if (actionError != null && actionError !== createErrorAtStart.current) actionFeedback.fail(new Error(actionError));
		else {
			actionFeedback.succeed();
			onClose();
		}
	}, [busy, actionError, creatingKey, actionFeedback.state, onClose]);
	useEffect(() => {
		previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		return () => {
			const previous = previousFocusRef.current;
			if (previous?.isConnected) previous.focus();
		};
	}, []);

	useEffect(() => {
		if (mode === "paths") inputRef.current?.focus();
		else rootRef.current?.focus();
	}, [mode]);
	useEffect(() => {
		if (!newFolderOpen) return;
		newFolderInputRef.current?.focus();
	}, [newFolderOpen]);


	const createFromOption = (option: PickerOption): void => {
		if (busy || !machine.reachable) return;
		if (overnightFeatureEnabled && overnightEnabled) {
			setOvernightCwd(option.kind === "workspace" ? option.workspace.cwd : option.path);
			setOvernightCreateDirectory(option.kind === "create");
			return;
		}
		const request = requestForPickerOption(option, model);
		if (!actionFeedback.begin()) return;
		saveLastCwd(request.cwd);
		saveLastMachine(machine.id);
		createObservedBusy.current = false;
		createErrorAtStart.current = actionError ?? null;
		setCreatingKey(pickerOptionKey(option));
		try {
			onCreate(request, machine.id);
		} catch (error) {
			actionFeedback.fail(error);
		}
	};
	const startOvernight = (overnight: StartOvernightRequest): void => {
		if (busy || !machine.reachable || overnightCwd === null) return;
		const option: PickerOption = overnightCreateDirectory
			? { kind: "create", path: overnightCwd }
			: { kind: "path", path: overnightCwd };
		const request = requestForPickerOption(option, model);
		if (!actionFeedback.begin()) return;
		saveLastCwd(request.cwd);
		saveLastMachine(machine.id);
		createObservedBusy.current = false;
		createErrorAtStart.current = actionError ?? null;
		setCreatingKey("overnight");
		try {
			onCreate({ ...request, overnight }, machine.id);
		} catch (error) {
			actionFeedback.fail(error);
		}
	};
	const startRecipe = async (recipe: SessionRecipe): Promise<void> => {
		if (busy || recipeStartingRef.current !== null || !machine.reachable || selectedApi.startRecipe === undefined) return;
		recipeStartingRef.current = recipe.id;
		setRecipeStarting(recipe.id);
		setRecipeStartError(null);
		setRecipeFeedback("pending");
		try {
			const session = await selectedApi.startRecipe(recipe.id, crypto.randomUUID());
			setRecipeFeedback("success");
			saveLastMachine(machine.id);
			if (onStartRecipe) onStartRecipe(session.id, machine.id);
			else window.location.hash = `session=${encodeURIComponent(machine.local ? session.id : `${machine.id}:${session.id}`)}`;
			onClose();
		} catch (error) {
			setRecipeFeedback("failure");
			setRecipeStartError(errorText(error));
			if (!machine.local) {
				if (isMachineNetworkError(error)) onMachineUnreachable?.(machine.id);
				else onMachineReachable?.(machine.id);
			}
		} finally {
			recipeStartingRef.current = null;
			setRecipeStarting(null);
		}
	};

	const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
		if (event.key === "Escape") {
			event.preventDefault();
			onClose();
			return;
		}
		const dialog = rootRef.current;
		if (event.key === "Tab" && dialog !== null) {
			const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
				"button:not(:disabled), input:not(:disabled), summary, [tabindex]:not([tabindex='-1'])",
			)).filter(element => element.getClientRects().length > 0 &&
				(element.tagName === "SUMMARY" || element.closest("details:not([open])") === null));
			const first = focusable[0];
			const last = focusable.at(-1);
			if (first && last && event.shiftKey && (document.activeElement === first || document.activeElement === dialog || !dialog.contains(document.activeElement))) {
				event.preventDefault();
				last.focus();
			} else if (first && last && !event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
				event.preventDefault();
				first.focus();
			}
			return;
		}

		const target = event.target;
		const inBrowseList = target instanceof Node && browseListRef.current?.contains(target) === true;
		const inRecentList = target instanceof Node && recentListRef.current?.contains(target) === true;
		const inPathOptions = target instanceof Node && pathOptionsRef.current?.contains(target) === true;
		const inPathPicker = target === inputRef.current || inPathOptions;
		if (event.key === "Backspace" && !(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement) &&
			!(target instanceof HTMLElement && target.isContentEditable) && browserExpanded && browse?.parent !== undefined) {
			event.preventDefault();
			setBrowseTarget(browse.parent);
			return;
		}
		if (inBrowseList && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
			event.preventDefault();
			setBrowseActiveIndex(index => pickerIndexAfterMove(index, event.key === "ArrowDown" ? 1 : -1, browse?.entries.length ?? 0));
			return;
		}
		if (inBrowseList && event.key === "Enter" && browseActiveIndex >= 0 && browse?.entries[browseActiveIndex]) {
			event.preventDefault();
			setBrowseTarget(browse.entries[browseActiveIndex]!.path);
			return;
		}
		if ((inRecentList || inPathPicker) && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
			event.preventDefault();
			setActiveIndex(index => pickerIndexAfterMove(index, event.key === "ArrowDown" ? 1 : -1, options.length));
			return;
		}
		if (!busy && (inRecentList || inPathPicker) && event.key === "Enter" && activeIndex >= 0 && options[activeIndex]) {
			event.preventDefault();
			createFromOption(options[activeIndex]!);
		}
	};

	const dialog = (
		<div
			className="dk-new-picker-backdrop"
			onClick={event => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<section
				className="dk-new-picker"
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				onKeyDown={onKeyDown}
				ref={rootRef}
				tabIndex={-1}
			>
				<header className="dk-new-picker-head">
					<div>
						<h2 id={titleId}>Start a session</h2>
						<p className="dk-new-prompt">
							Which project should the agent work on? Choose its folder — the agent can read and change files inside it.
						</p>
					</div>
					<button type="button" className="sh-btn sh-btn-icon" aria-label="Close new session picker" onClick={onClose}>
						×
					</button>
				</header>
				{machineList.length > 1 && (
					<div className="dk-machine-switch" role="radiogroup" aria-label="Run on">
						<span className="dk-machine-switch-label">Run on</span>
						{machineList.map(item => (
							<button
								key={item.id}
								type="button"
								role="radio"
								aria-checked={item.id === machine.id}
								className={item.id === machine.id ? "dk-machine-choice dk-machine-choice-on" : "dk-machine-choice"}
								disabled={!item.local && !item.reachable}
								title={!item.local && !item.reachable ? `${item.name} is unreachable` : `Start the session on ${item.name}`}
								onClick={() => {
									setMachineId(item.id);
									setSuggestions(null);
									setSuggestionError(null);
									setPaths(null);
									setPathError(null);
									setBrowse(null);
									setBrowseError(null);
									setBrowseTarget(undefined);
									setBrowseOpen(false);
									setNewFolderOpen(false);
									setNewFolderName("");
									setOvernightCwd(null);
									setOvernightCreateDirectory(false);
								}}
							>
								{item.name}
							</button>
						))}
					</div>
				)}
				{!machine.local && machine.reachable && (
					<p className="dk-hint dk-machine-hint">Runs on {machine.name}: it keeps working while this device sleeps or is offline.</p>
				)}
				{wanted !== undefined && !wanted.local && !wanted.reachable && (
					<p className="dk-machine-unreachable" role="status">{wanted.name} unreachable — this session starts on {machine.name}.</p>
				)}
				{(overnightFeatureEnabled || recipes.length > 0) && (
					<details className="dk-new-more-options">
						<summary>More options</summary>
						{overnightFeatureEnabled && (
							<div className="dk-new-overnight-toggle">
								<button
									type="button"
									role="switch"
									aria-checked={overnightEnabled}
									disabled={busy || !machine.reachable}
									className="dk-new-overnight-switch"
									onClick={() => setOvernightEnabled(enabled => !enabled)}
								>
									<Moon size={15} aria-hidden="true" />
									<span><strong>Overnight run</strong><small>Run with your saved overnight policy.</small></span>
									<span className="dk-new-overnight-switch-state">{overnightEnabled ? "On" : "Off"}</span>
								</button>
								{overnightEnabled && (
									<OvernightSetup
										api={selectedApi}
										cwd={overnightCwd}
										busy={busy}
										startLabel="Start overnight run"
										onStart={startOvernight}
									/>
								)}
							</div>
						)}
						{mode === "browse" && recipes.length > 0 && (
							<section className="dk-recipe-list" aria-label="Session templates">
								<h3>Session templates</h3>
								{recipes.map(recipe => (
									<button
										type="button"
										key={recipe.id}
										className="dk-recipe-option"
										disabled={busy || !machine.reachable || recipeStarting !== null}
										onClick={() => void startRecipe(recipe)}
									>
										<ActionFeedbackMark state={recipeStarting === recipe.id ? recipeFeedback : "idle"} />
										<span><strong>Start: {recipe.name}</strong><small>{shortenPath(recipe.cwd)}</small></span>
									</button>
								))}
								{recipeStartError && <p className="dk-new-error" role="alert">{recipeStartError}</p>}
							</section>
						)}
					</details>
				)}
				{recipesError && <p className="dk-new-error" role="status">Could not check optional session templates: {recipesError}</p>}

				{suggestions === null && suggestionError === null && machine.reachable && (
					<p className="dk-new-hint" role="status">Looking for recent projects…</p>
				)}
				{suggestionError !== null && (
					<div className="dk-new-error-row" role="alert">
						<p className="dk-new-error">Couldn't load recent projects.</p>
						<button type="button" className="sh-btn" disabled={busy} onClick={() => setSuggestionAttempt(attempt => attempt + 1)}>
							Retry
						</button>
					</div>
				)}
				{recentProjects.length > 0 && (
					<section className="dk-new-section" aria-labelledby={`${titleId}-recent`}>
						<h3 id={`${titleId}-recent`}>Recent projects</h3>
						<div ref={recentListRef} className={`dk-new-options dk-new-recent-list${browserExpanded ? " dk-new-recent-list-compact" : ""}`} role="listbox" aria-label="Recent projects">
							{recentProjects.map((workspace, index) => {
								const option: PickerOption = { kind: "workspace", workspace };
								const key = pickerOptionKey(option);
								return (
									<WorkspaceOption
										key={workspace.cwd}
										workspace={workspace}
										active={index === activeIndex || (overnightEnabled && overnightCwd === workspace.cwd)}
										disabled={busy || !machine.reachable || creatingKey !== null}
										feedbackState={creatingKey === key ? actionFeedback.state : "idle"}
										onChoose={() => createFromOption(option)}
										onHover={() => setActiveIndex(index)}
									/>
								);
							})}
						</div>
					</section>
				)}

				{mode === "browse" && (
					<section className="dk-new-section" aria-label="Browse folders">
						{recentProjects.length > 0 && (
							<button
								type="button"
								className="dk-new-browse-toggle"
								aria-expanded={browserExpanded}
								onClick={() => setBrowseOpen(open => !open)}
							>
								<ChevronRight size={15} aria-hidden="true" />
								Browse folders…
							</button>
						)}
						{browserExpanded && (
							<div className="dk-new-browser">
								<h3>Browse</h3>
								{browseLoading && <p className="dk-new-hint" role="status">Loading folders…</p>}
								{browseError !== null && (
									<div className="dk-new-error-row" role="alert">
										<p className="dk-new-error">{browseError}</p>
										{machine.reachable && (
											<button type="button" className="sh-btn" disabled={busy} onClick={() => setBrowseAttempt(attempt => attempt + 1)}>
												Retry
											</button>
										)}
									</div>
								)}
								{browse !== null && browseError === null && (
									<>
										<nav className="dk-new-breadcrumbs" aria-label="Folder path">
											{newSessionBreadcrumbs(browse.home, browse.dir).map((crumb, index, crumbs) => (
												<span className="dk-new-crumb" key={crumb.path}>
													{index < crumbs.length - 1 ? (
														<button
															type="button"
															disabled={busy || browseLoading}
															onClick={() => {
																setBrowseTarget(crumb.path);
																setNewFolderOpen(false);
																setNewFolderName("");
															}}
														>
															{crumb.label === "Home" ? <><Home size={13} aria-hidden="true" /> Home</> : crumb.label}
														</button>
													) : (
														<span aria-current="location">
															{crumb.label === "Home" ? <><Home size={13} aria-hidden="true" /> Home</> : crumb.label}
														</span>
													)}
													{index < crumbs.length - 1 && <ChevronRight size={13} aria-hidden="true" />}
												</span>
											))}
										</nav>
										<div
											ref={browseListRef}
											className="dk-new-options dk-new-folder-list"
											role="listbox"
											tabIndex={0}
											aria-label={`Folders in ${shortenPath(browse.dir)}`}
											aria-activedescendant={browseActiveIndex >= 0 ? `dk-new-folder-${browseActiveIndex}` : undefined}
										>
											{browse.entries.map((entry, index) => (
												<button
													type="button"
													key={entry.path}
													id={`dk-new-folder-${index}`}
													role="option"
													aria-selected={index === browseActiveIndex}
													className="dk-new-option"
													data-active={index === browseActiveIndex ? "true" : "false"}
													disabled={busy || browseLoading}
													onMouseEnter={() => setBrowseActiveIndex(index)}
													onClick={() => {
														setBrowseTarget(entry.path);
														setNewFolderOpen(false);
														setNewFolderName("");
													}}
												>
													<FolderOpen size={15} aria-hidden="true" />
													<span className="dk-new-option-main"><strong>{entry.name}</strong></span>
													<ChevronRight size={14} aria-hidden="true" />
												</button>
											))}
										</div>
										{browse.entries.length === 0 && (
											<p className="dk-new-hint">
												{canCreateHere ? "No folders here. Use this folder, or create one." : "No folders here. Use this folder."}
											</p>
										)}
										{browse.truncated && <p className="dk-new-hint">Showing the first 500 folders.</p>}
										<div className="dk-new-folder-actions">
											<button
												type="button"
												className="dk-wide-btn dk-wide-btn-primary"
												disabled={busy || !machine.reachable || browseLoading || (newFolderOpen && !newFolderNameValid)}
												onClick={() => createFromOption(newFolderOpen
													? { kind: "create", path: newFolderPath(browse.dir, newFolderName) }
													: { kind: "path", path: browse.dir })}
											>
												{newFolderOpen
													? newFolderNameValid ? `Create “${newFolderName.trim()}” and start` : "Create folder and start"
													: `Start in “${pathKey(browse.dir) === pathKey(browse.home) ? "Home" : basename(browse.dir)}”`}
											</button>
											{canCreateHere && !newFolderOpen && (
												<button
													type="button"
													className="sh-btn"
													disabled={busy || browseLoading}
													onClick={() => {
														setNewFolderName("");
														setNewFolderOpen(true);
													}}
												>
													<Plus size={14} aria-hidden="true" />
													New folder
												</button>
											)}
										</div>
										{newFolderOpen && canCreateHere && (
											<div className="dk-new-folder-form">
												<label className="sh-field">
													<span className="sh-field-label">New folder name</span>
													<input
														ref={newFolderInputRef}
														className="sh-input"
														autoComplete="off"
														value={newFolderName}
														onChange={event => setNewFolderName(event.currentTarget.value)}
														placeholder="e.g. my-app"
													/>
												</label>
												<p className="dk-new-hint">Will be created when the session starts.</p>
												{cleanNewFolderName !== "" && !newFolderNameValid && <p className="dk-new-error" role="alert">Enter a folder name, not a path.</p>}
												<button type="button" className="sh-btn" onClick={() => setNewFolderOpen(false)}>Cancel</button>
											</div>
										)}
									</>
								)}
							</div>
						)}
					</section>
				)}

				{mode === "browse" ? (
					<button type="button" className="dk-new-text-link" onClick={() => setMode("paths")}>
						Type a path
					</button>
				) : (
					<section className="dk-new-section" aria-label="Type a path">
						<button
							type="button"
							className="dk-new-text-link"
							onClick={() => {
								setMode("browse");
								setBrowseOpen(true);
							}}
						>
							Browse folders…
						</button>
						<label className="sh-field">
							<span className="sh-field-label">Type a path</span>
							<input
								ref={inputRef}
								className="sh-input sh-input-mono"
								role="combobox"
								aria-expanded={options.length > 0}
								aria-controls="dk-new-path-options"
								autoComplete="off"
								spellCheck={false}
								value={query}
								onChange={event => setQuery(event.target.value)}
								placeholder="~/code, /home/you/project, or C:\\Users\\you\\project"
							/>
						</label>
						<div ref={pathOptionsRef} id="dk-new-path-options" className="dk-new-options" role="listbox" aria-label="Matching folders">
							{pathOptions.map((option, index) => (
								<PathOption
									key={pickerOptionKey(option)}
									option={option}
									active={index === activeIndex || (overnightEnabled && overnightCwd !== null && pathKey(overnightCwd) === pathKey(option.path))}
									disabled={busy || !machine.reachable || creatingKey !== null}
									feedbackState={creatingKey === pickerOptionKey(option) ? actionFeedback.state : "idle"}
									onChoose={() => createFromOption(option)}
									onHover={() => setActiveIndex(index)}
								/>
							))}
						</div>
						{query.trim() === "" && machine.reachable && (
							<p className="dk-new-hint">Enter a folder name or an absolute path. Suggestions show folders you can use.</p>
						)}
						{pathError !== null && (
							<div className="dk-new-error-row" role="alert">
								<p className="dk-new-error">{pathError}</p>
								<button type="button" className="sh-btn" disabled={busy} onClick={() => setPathAttempt(attempt => attempt + 1)}>
									Retry
								</button>
							</div>
						)}
						{machine.reachable && paths !== null && options.length === 0 && (
							<p className="dk-new-hint">No matching folders. Try a different name.</p>
						)}
					</section>
				)}

				{!machine.reachable && <p className="dk-new-error" role="status">This computer is unreachable. Choose another computer to browse its folders.</p>}
				<details className="dk-new-model">
					<summary>
						<ChevronDown size={13} />
						Model (optional)
					</summary>
					<input
						className="sh-input sh-input-mono"
						aria-label="Model (optional)"
						value={model}
						onChange={event => setModel(event.target.value)}
						placeholder="default"
						autoComplete="off"
						spellCheck={false}
					/>
				</details>
				{recipeStarting !== null && <p className="dk-new-hint" role="status">Starting session template…</p>}
				{creatingKey !== null && (
					<ActionFeedbackMessage
						state={actionFeedback.state}
						error={actionFeedback.error}
						pendingLabel="Starting session…"
						successLabel="Opening session…"
					/>
				)}
			</section>
		</div>
	);
	return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);

}

function recentUsageLabel(lastUsedAt: number): string {
	if (lastUsedAt <= 0) return "Not used yet";
	const days = Math.floor(Math.max(0, Date.now() - lastUsedAt) / 86_400_000);
	if (days === 1) return "Used yesterday";
	if (days > 1) return `Used ${days} days ago`;
	return `Used ${relTime(lastUsedAt)}`;
}

function WorkspaceOption({
	workspace,
	active,
	disabled,
	feedbackState,
	onChoose,
	onHover,
}: {
	workspace: WorkspaceUsage;
	active: boolean;
	disabled: boolean;
	feedbackState: ActionFeedbackState;
	onChoose(): void;
	onHover(): void;
}): ReactNode {
	return (
		<button
			type="button"
			role="option"
			aria-selected={active}
			className="dk-new-option"
			data-active={active ? "true" : "false"}
			disabled={disabled}
			aria-busy={feedbackState === "pending"}
			onMouseEnter={onHover}
			onClick={onChoose}
		>
			<FolderOpen size={14} />
			<ActionFeedbackMark state={feedbackState} />
			<span className="dk-new-option-main">
				<strong>{workspace.name}</strong>
				<small>{shortenPath(workspace.cwd)}</small>
				<small className="dk-new-used">{recentUsageLabel(workspace.lastUsedAt)}</small>
			</span>
		</button>
	);
}

function PathOption({
	option,
	active,
	disabled,
	feedbackState,
	onChoose,
	onHover,
}: {
	option: PathPickerOption;
	active: boolean;
	disabled: boolean;
	feedbackState: ActionFeedbackState;
	onChoose(): void;
	onHover(): void;
}): ReactNode {
	const create = option.kind === "create";
	const path = option.path;
	return (
		<button
			type="button"
			role="option"
			aria-selected={active}
			className={create ? "dk-new-option dk-new-option-action" : "dk-new-option"}
			data-active={active ? "true" : "false"}
			aria-busy={feedbackState === "pending"}
			disabled={disabled}
			onMouseEnter={onHover}
			onClick={onChoose}
		>
			{create ? <Plus size={14} /> : <FolderOpen size={14} />}
			<ActionFeedbackMark state={feedbackState} />
			<span className="dk-new-option-main">
				<span>{create ? `Create ${path}` : path}</span>
				{!create && <code>{shortenPath(path)}</code>}
			</span>
		</button>
	);
}
