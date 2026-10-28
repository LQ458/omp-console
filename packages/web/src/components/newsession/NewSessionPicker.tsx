import type { SessionRecipe } from "@omp-console/protocol";
import type { CreateSessionRequest, NewSessionSuggestions, PathSuggestions, StartOvernightRequest, WorkspaceUsage } from "@omp-console/protocol";
import { ChevronDown, FolderOpen, Moon, Plus } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActionFeedbackMark, ActionFeedbackMessage } from "../shell/ActionFeedback";
import type { DeckApi } from "../../lib/api";
import { isMachineNetworkError, type Machine } from "../../lib/machines";
import { shortenPath } from "../../lib/format";
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
	| { kind: "new" }
	| { kind: "path" | "create"; path: string };

type PathPickerOption = Extract<PickerOption, { kind: "path" | "create" }>;

type PickerApi = Pick<
	DeckApi,
	"newSessionSuggestions" | "pathSuggestions" | "getOvernightTemplate" | "getOvernightPreflight"
> & Partial<Pick<DeckApi, "listRecipes" | "startRecipe">>;

type PickerMachine = Pick<Machine, "id" | "name" | "local" | "reachable"> & {
	api: PickerApi;
};

export interface NewSessionPickerProps {
	api: PickerApi;
	/** Kept for older callers; project discovery is available without the librarian feature. */
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

export function requestForPickerOption(option: PickerOption, model: string): CreateSessionRequest | null {
	const cwd = option.kind === "workspace" ? option.workspace.cwd : option.kind === "path" || option.kind === "create" ? option.path : null;
	if (cwd === null) return null;
	const request: CreateSessionRequest = option.kind === "create" ? { cwd, createDirectory: true } : { cwd };
	if (model.trim() !== "") request.model = model.trim();
	return request;
}
function pickerOptionKey(option: PickerOption): string {
	if (option.kind === "workspace") return `workspace:${option.workspace.cwd}`;
	if (option.kind === "new") return "new";
	return `${option.kind}:${option.path}`;
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
	const [mode, setMode] = useState<"recent" | "paths">(initialPath === null ? "recent" : "paths");
	const [query, setQuery] = useState(initialPath ?? "");
	const [paths, setPaths] = useState<PathSuggestions | null>(null);
	const [pathError, setPathError] = useState<string | null>(null);
	const [model, setModel] = useState("");
	const [overnightEnabled, setOvernightEnabled] = useState(false);
	const [overnightCwd, setOvernightCwd] = useState<string | null>(initialPath);
	const [overnightCreateDirectory, setOvernightCreateDirectory] = useState(false);
	const [activeIndex, setActiveIndex] = useState(0);
	const rootRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const [suggestionAttempt, setSuggestionAttempt] = useState(0);
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
					setSuggestionError(errorText(error));
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
		if (initialPath === null) {
			setMode("recent");
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
						setPathError(errorText(error));
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
	}, [selectedApi, machine, mode, query, onMachineReachable, onMachineUnreachable]);

	const pathOptions = useMemo<PathPickerOption[]>(() => {
		const typedQuery = query.trim().toLowerCase();
		const recentPaths = (suggestions?.recent ?? [])
			.filter(workspace =>
				typedQuery === "" ||
				(!typedQuery.startsWith("/") &&
					!typedQuery.startsWith("~") &&
					(workspace.name.toLowerCase().includes(typedQuery) || workspace.cwd.toLowerCase().includes(typedQuery))),
			)
			.map(workspace => ({ kind: "path" as const, path: workspace.cwd }));
		const matches: PathPickerOption[] = [...recentPaths];
		for (const match of paths?.matches ?? []) {
			if (!matches.some(option => option.path === match.path)) matches.push({ kind: "path", path: match.path });
		}
		const typedPathIsCreate = paths?.create?.path === paths?.typedPath;
		if (paths?.create && !typedPathIsCreate) matches.push({ kind: "create", path: paths.create.path });
		if (paths?.typedPath && !matches.some(option => option.path === paths.typedPath)) {
			matches.unshift(typedPathIsCreate ? { kind: "create", path: paths.typedPath } : { kind: "path", path: paths.typedPath });
		}
		// Keep a typed absolute path available even when the directory scan could not find it.
		const typed = query.trim().replace(/\/+$/, "");
		if (typed.startsWith("/") && typed.length > 1 && !matches.some(option => option.path === typed)) {
			matches.unshift(paths?.create?.path === typed ? { kind: "create", path: typed } : { kind: "path", path: typed });
		}
		return matches;
	}, [paths, query, suggestions]);
	const options = useMemo<PickerOption[]>(() => {
		if (mode === "recent") {
			return [...(suggestions?.recent ?? []).map(workspace => ({ kind: "workspace" as const, workspace })), { kind: "new" }];
		}
		return pathOptions;
	}, [mode, pathOptions, suggestions]);
	useEffect(() => {
		if (overnightCwd !== null) return;
		const suggestedPath = suggestions?.recent[0]?.cwd ?? (mode === "paths" ? paths?.matches[0]?.path : undefined);
		if (suggestedPath !== undefined) setOvernightCwd(suggestedPath);
	}, [mode, overnightCwd, paths, suggestions]);

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
		if (mode === "paths") inputRef.current?.focus();
		else rootRef.current?.focus();
	}, [mode]);

	const createFromOption = (option: PickerOption): void => {
		if (busy || !machine.reachable) return;
		if (option.kind === "new") {
			setMode("paths");
			setQuery("");
			return;
		}
		if (overnightFeatureEnabled && overnightEnabled) {
			setOvernightCwd(option.kind === "workspace" ? option.workspace.cwd : option.path);
			setOvernightCreateDirectory(option.kind === "create");
			return;
		}
		const request = requestForPickerOption(option, model);
		if (request === null || !actionFeedback.begin()) return;
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
		if (request === null || !actionFeedback.begin()) return;
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

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
		if (event.key === "Escape") {
			event.preventDefault();
			onClose();
			return;
		}
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			setActiveIndex(index => pickerIndexAfterMove(index, event.key === "ArrowDown" ? 1 : -1, options.length));
			return;
		}
		if (!busy && event.key === "Enter" && activeIndex >= 0 && options[activeIndex]) {
			event.preventDefault();
			createFromOption(options[activeIndex]!);
		}
	};

	return (
		<div className="dk-new-picker" role="region" aria-label="New session" onKeyDown={onKeyDown} ref={rootRef} tabIndex={-1}>
			<div className="dk-new-picker-head">
				<strong>Start a session</strong>
				<button type="button" className="sh-btn sh-btn-icon" aria-label="Close new session picker" onClick={onClose}>
					×
				</button>
			</div>
			<p className="dk-new-prompt">Choose a project folder</p>
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
					{mode === "recent" && recipes.length > 0 && (
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
			{mode === "recent" ? (
				<>
					<div className="dk-new-options" role="listbox" aria-label="Recent project folders">
						{(suggestions?.recent ?? []).map((workspace, index) => {
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
						<button
							type="button"
							role="option"
							aria-selected={activeIndex === (suggestions?.recent.length ?? 0)}
							className="dk-new-option dk-new-option-action"
							data-active={activeIndex === (suggestions?.recent.length ?? 0) ? "true" : "false"}
							disabled={busy || !machine.reachable || creatingKey !== null}
							onMouseEnter={() => setActiveIndex(suggestions?.recent.length ?? 0)}
							onClick={() => createFromOption({ kind: "new" })}
						>
							<Plus size={14} />
							Choose another folder…
						</button>
					</div>
					{suggestions === null && !suggestionError && machine.reachable && <p className="dk-new-hint" role="status">Loading project folders…</p>}
					{machine.reachable && suggestions?.recent.length === 0 && <p className="dk-new-hint">No recent project folders yet. Choose another folder and enter its path.</p>}
					{machine.reachable && suggestionError && <p className="dk-new-error" role="alert">Could not load recent sessions: {suggestionError}</p>}
					{machine.reachable && suggestionError && (
						<button type="button" className="sh-btn" disabled={busy} onClick={() => setSuggestionAttempt(attempt => attempt + 1)}>
							Retry
						</button>
					)}
				</>
			) : (
				<>
					<label className="sh-field">
						<span className="sh-field-label">Choose a project folder</span>
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
							placeholder="~/code or /home/you/project"
						/>
					</label>
					<div id="dk-new-path-options" className="dk-new-options" role="listbox" aria-label="Matching directories">
						{pathOptions.map((option, index) => (
							<PathOption
								key={`${option.kind}:${option.path}`}
								option={option}
								active={index === activeIndex || (overnightEnabled && overnightCwd === option.path)}
								disabled={busy || !machine.reachable || creatingKey !== null}
								feedbackState={creatingKey === pickerOptionKey(option) ? actionFeedback.state : "idle"}
								onChoose={() => createFromOption(option)}
								onHover={() => setActiveIndex(index)}
							/>
						))}
					</div>
					{mode === "paths" && query.trim() === "" && machine.reachable && <p className="dk-new-hint">Type a folder name or a path such as ~/code or /home/you/project.</p>}
					{machine.reachable && pathError && <p className="dk-new-error" role="alert">Could not search folders: {pathError}</p>}
					{machine.reachable && paths && options.length === 0 && <p className="dk-new-hint">No matching folders. Try a different name.</p>}
				</>
			)}
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
		</div>
	);
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
				<span>{workspace.name} <span className="dk-new-count">({workspace.sessions30d} sessions)</span></span>
				<code>{shortenPath(workspace.cwd)}</code>
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
