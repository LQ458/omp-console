/**
 * Extension UI forwarding (`{t:"ext-ui"}`): what the session's extensions publish through the UI context they were
 * initialised with (`setStatus`, `setWidget`, `notify`) becomes one whole-state line for the daemon, debounced so a
 * burst of updates (a progress widget redrawn on every tool call) costs one line.
 *
 * Widgets: a string-array widget is forwarded as `widgets`. A widget whose key starts with `omp-console:` is an omp console panel
 * when its value is a valid `DeckPanelDescriptor`: either the descriptor object itself, or (the only form the typed
 * `setWidget` accepts) a one-element string array holding the descriptor as JSON. The panel's key is the part after
 * `omp-console:`. Component-factory widgets draw terminal cells and have nothing to forward.
 */
import type { DeckPanelDescriptor, ExtensionUiState } from "@omp-console/protocol";
import { logger } from "@oh-my-pi/pi-utils";
import type { StatusSink } from "./status";

export const OMP_CONSOLE_PANEL_PREFIX = "omp-console:";
export const EXT_UI_DEBOUNCE_MS = 200;
const MAX_NOTIFICATIONS = 20;
const MAX_TEXT = 4000;

type NotificationLevel = ExtensionUiState["notifications"][number]["level"];

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
}

/** The descriptor `value` encodes, or `undefined` when it is not a complete, well-typed `DeckPanelDescriptor`. */
export function parseDeckPanel(value: unknown): DeckPanelDescriptor | undefined {
	if (!isObject(value) || typeof value.title !== "string") return undefined;
	switch (value.kind) {
		case "list":
			if (
				Array.isArray(value.items) &&
				value.items.every(item => isObject(item) && typeof item.label === "string" && (item.detail === undefined || typeof item.detail === "string"))
			) {
				return {
					kind: "list",
					title: value.title,
					items: (value.items as Array<{ label: string; detail?: string }>).map(item =>
						item.detail === undefined ? { label: item.label } : { label: item.label, detail: item.detail },
					),
				};
			}
			return undefined;
		case "kv":
			if (Array.isArray(value.rows) && value.rows.every(row => isObject(row) && typeof row.key === "string" && typeof row.value === "string")) {
				return {
					kind: "kv",
					title: value.title,
					rows: (value.rows as Array<{ key: string; value: string }>).map(row => ({ key: row.key, value: row.value })),
				};
			}
			return undefined;
		case "progress":
			if (
				typeof value.value === "number" &&
				Number.isFinite(value.value) &&
				typeof value.max === "number" &&
				Number.isFinite(value.max) &&
				(value.label === undefined || typeof value.label === "string")
			) {
				return value.label === undefined
					? { kind: "progress", title: value.title, value: value.value, max: value.max }
					: { kind: "progress", title: value.title, value: value.value, max: value.max, label: value.label };
			}
			return undefined;
		case "markdown":
			return typeof value.text === "string" ? { kind: "markdown", title: value.title, text: value.text } : undefined;
		case "table":
			if (isStringArray(value.columns) && Array.isArray(value.rows) && value.rows.every(isStringArray)) {
				return {
					kind: "table",
					title: value.title,
					columns: [...value.columns],
					rows: (value.rows as string[][]).map(row => [...row]),
				};
			}
			return undefined;
		case "buttons":
			if (
				Array.isArray(value.buttons) &&
				value.buttons.every(button => isObject(button) && typeof button.label === "string" && typeof button.command === "string")
			) {
				return {
					kind: "buttons",
					title: value.title,
					buttons: (value.buttons as Array<{ label: string; command: string }>).map(button => ({
						label: button.label,
						command: button.command,
					})),
				};
			}
			return undefined;
		default:
			return undefined;
	}
}

/** A descriptor given as the object itself or as a one-element string array holding its JSON. */
function descriptorOf(content: unknown): DeckPanelDescriptor | undefined {
	if (isObject(content)) return parseDeckPanel(content);
	if (Array.isArray(content) && content.length === 1 && typeof content[0] === "string") {
		try {
			return parseDeckPanel(JSON.parse(content[0]));
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function clip(text: string): string {
	return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

/** Hooks the guest UI context calls; `ExtUiReporter` implements them. */
export interface ExtUiHooks {
	setStatus(key: string, text: string | undefined): void;
	setWidget(key: string, content: unknown): void;
	notify(message: string, level: NotificationLevel | undefined): void;
}

export class ExtUiReporter implements ExtUiHooks {
	readonly #sink: StatusSink;
	readonly #debounceMs: number;
	readonly #statuses = new Map<string, string>();
	readonly #widgets = new Map<string, string[]>();
	readonly #panels = new Map<string, DeckPanelDescriptor>();
	#notifications: ExtensionUiState["notifications"] = [];
	#timer: Timer | undefined;
	#disposed = false;

	constructor(sink: StatusSink, debounceMs = EXT_UI_DEBOUNCE_MS) {
		this.#sink = sink;
		this.#debounceMs = debounceMs;
	}

	setStatus(key: string, text: string | undefined): void {
		if (text === undefined) this.#statuses.delete(key);
		else this.#statuses.set(key, clip(text));
		this.#schedule();
	}

	setWidget(key: string, content: unknown): void {
		if (key.startsWith(OMP_CONSOLE_PANEL_PREFIX)) {
			const panelKey = key.slice(OMP_CONSOLE_PANEL_PREFIX.length);
			const descriptor = panelKey === "" ? undefined : descriptorOf(content);
			if (descriptor) {
				this.#widgets.delete(key);
				this.#panels.set(panelKey, descriptor);
				this.#schedule();
				return;
			}
			// Not a valid descriptor: only a plain string-array widget stays visible, as any other widget does.
			this.#panels.delete(panelKey);
		}
		if (isStringArray(content)) this.#widgets.set(key, content.map(clip));
		else this.#widgets.delete(key);
		this.#schedule();
	}

	notify(message: string, level: NotificationLevel | undefined): void {
		this.#notifications = [...this.#notifications, { at: Date.now(), message: clip(message), level: level ?? "info" }].slice(
			-MAX_NOTIFICATIONS,
		);
		this.#schedule();
	}

	/** The whole state as the daemon last (or next) sees it. */
	snapshot(): ExtensionUiState {
		return {
			statuses: [...this.#statuses].map(([key, text]) => ({ key, text })),
			widgets: [...this.#widgets].map(([key, lines]) => ({ key, lines: [...lines] })),
			panels: [...this.#panels].map(([key, descriptor]) => ({ key, descriptor })),
			notifications: this.#notifications.map(entry => ({ ...entry })),
		};
	}

	#schedule(): void {
		if (this.#disposed || this.#timer) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.flush();
		}, this.#debounceMs);
		this.#timer.unref();
	}

	/** Emit the current state now, cancelling a pending debounced emit. */
	flush(): void {
		if (this.#disposed) return;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		try {
			this.#sink.emit({ t: "ext-ui", state: this.snapshot() });
		} catch (error) {
			logger.warn("ext-ui line failed", { error: String(error) });
		}
	}

	dispose(): void {
		this.#disposed = true;
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}
}
