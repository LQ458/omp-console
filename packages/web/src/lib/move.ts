/**
 * Safe move flow (grand-list 9, red-team A1-A9). The move is a deck action, never an agent tool, and the daemon
 * refuses `POST /api/moves/:id/confirm` without a token signed by the native Mac app. This client therefore never
 * builds a token itself:
 *
 *   prepare -> preview (daemon facts) -> native confirmation (Tauri `confirm_move`) -> token -> `confirmMove`
 *
 * Without a Tauri bridge (a browser, an iPhone) the flow stops at "Confirm on the Mac app" and calls nothing: there
 * is no fallback confirmation. A cancelled or late native dialog can never execute a move that was cancelled or has
 * expired in the meantime.
 */
import type {
	DriftSuggestion,
	MoveConfirmRequest,
	MovePrepareRequest,
	MovePreview,
	MoveRecord,
} from "@omp-console/protocol";
import { DeckApiError } from "./api";

export type NativeInvoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;

interface TauriGlobals {
	__TAURI__?: { core?: { invoke?: NativeInvoke }; invoke?: NativeInvoke };
	__TAURI_INTERNALS__?: { invoke?: NativeInvoke };
}

/** The Tauri `invoke`, from `window.__TAURI__` (global API) or `window.__TAURI_INTERNALS__`; null outside the Mac app. */
export function nativeInvoke(target: object = globalThis): NativeInvoke | null {
	const globals = target as TauriGlobals;
	const candidate =
		globals.__TAURI__?.core?.invoke ?? globals.__TAURI__?.invoke ?? globals.__TAURI_INTERNALS__?.invoke ?? null;
	return typeof candidate === "function" ? candidate : null;
}

const SLUG_MAX = 48;

/** `[a-z0-9-]` only, no leading, trailing or doubled hyphen: what the daemon accepts as a destination name. */
export function validateSlug(slug: string): { ok: true } | { ok: false; message: string } {
	if (slug === "") return { ok: false, message: "Enter a folder name." };
	if (slug.length > SLUG_MAX) return { ok: false, message: `At most ${SLUG_MAX} characters.` };
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
		return { ok: false, message: "Lowercase letters, digits and single hyphens only." };
	}
	return { ok: true };
}

/** Turns free text into a valid slug (ASCII only: lookalike unicode letters are dropped, not transliterated). */
export function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, SLUG_MAX)
		.replace(/-+$/g, "");
}

export type MoveState =
	| { phase: "idle" }
	| { phase: "preparing"; slug: string }
	| { phase: "preview"; slug: string; preview: MovePreview; note?: string }
	| { phase: "needs-mac"; slug: string; preview: MovePreview }
	| { phase: "confirming"; slug: string; preview: MovePreview }
	| { phase: "done"; record: MoveRecord }
	| { phase: "expired"; slug: string }
	| { phase: "failed"; slug: string; message: string };

export interface MoveApi {
	prepareMove(request: MovePrepareRequest): Promise<MovePreview>;
	confirmMove(moveId: string, confirm: MoveConfirmRequest): Promise<MoveRecord>;
}

export interface MoveFlowOptions {
	api: MoveApi;
	/** Resolved lazily so a bridge injected after load is found; default reads `window`. */
	invoke?: () => NativeInvoke | null;
	now?: () => number;
	onDone?: (record: MoveRecord) => void;
}

function describeConfirmError(err: unknown): string {
	if (err instanceof DeckApiError) {
		if (err.status === 403) return "The daemon did not accept the Mac app's confirmation. Nothing was copied.";
		// The daemon names the conflict (source changed, preview expired, destination not empty, session gone).
		if (err.status === 409) return `Nothing was copied: ${err.message}. Prepare the move again.`;
		if (err.kind === "not-found") return "This move is no longer prepared. Prepare it again.";
		return err.message;
	}
	return err instanceof Error ? err.message : "The move failed.";
}

export class MoveFlow {
	readonly #api: MoveApi;
	readonly #invoke: () => NativeInvoke | null;
	readonly #now: () => number;
	readonly #onDone: ((record: MoveRecord) => void) | undefined;
	readonly #listeners = new Set<() => void>();
	#state: MoveState = { phase: "idle" };
	/** Bumped by every prepare/cancel so a result that arrives after either is discarded. */
	#epoch = 0;

	constructor(options: MoveFlowOptions) {
		this.#api = options.api;
		this.#invoke = options.invoke ?? (() => nativeInvoke());
		this.#now = options.now ?? Date.now;
		this.#onDone = options.onDone;
	}

	getState = (): MoveState => this.#state;

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	};

	#set(state: MoveState): void {
		this.#state = state;
		for (const listener of this.#listeners) listener();
	}

	/** Asks the daemon for a preview. A second prepare replaces the first. */
	async prepare(suggestion: Pick<DriftSuggestion, "id">, slug: string): Promise<void> {
		const valid = validateSlug(slug);
		if (!valid.ok) {
			this.#set({ phase: "failed", slug, message: valid.message });
			return;
		}
		const epoch = ++this.#epoch;
		this.#set({ phase: "preparing", slug });
		try {
			const preview = await this.#api.prepareMove({ suggestionId: suggestion.id, slug });
			if (epoch !== this.#epoch) return;
			this.#set(this.#invoke() === null ? { phase: "needs-mac", slug, preview } : { phase: "preview", slug, preview });
		} catch (err) {
			if (epoch !== this.#epoch) return;
			this.#set({ phase: "failed", slug, message: err instanceof Error ? err.message : "Could not prepare the move." });
		}
	}

	/** Native confirmation, then the daemon. Does nothing outside `preview`/`needs-mac`, and never without the bridge. */
	async confirm(): Promise<void> {
		const state = this.#state;
		if (state.phase !== "preview" && state.phase !== "needs-mac") return;
		const { preview, slug } = state;
		const invoke = this.#invoke();
		if (invoke === null) {
			this.#set({ phase: "needs-mac", slug, preview });
			return;
		}
		if (this.#now() >= preview.expiresAt) {
			this.#epoch++;
			this.#set({ phase: "expired", slug });
			return;
		}
		const epoch = ++this.#epoch;
		this.#set({ phase: "confirming", slug, preview });
		let token: unknown;
		try {
			// The Mac app fetches this move from the daemon itself and builds the dialog from those facts.
			token = await invoke("confirm_move", { moveId: preview.id, nonce: preview.nonce });
		} catch {
			if (epoch !== this.#epoch) return;
			this.#set({ phase: "preview", slug, preview, note: "Not confirmed on the Mac. Nothing was copied." });
			return;
		}
		// Cancelled, replaced or expired while the dialog was open: the approval must not execute anything.
		if (epoch !== this.#epoch) return;
		if (typeof token !== "string" || token === "") {
			this.#set({ phase: "failed", slug, message: "The Mac app returned no confirmation token." });
			return;
		}
		if (this.#now() >= preview.expiresAt) {
			this.#set({ phase: "expired", slug });
			return;
		}
		try {
			const record = await this.#api.confirmMove(preview.id, { nonce: preview.nonce, token });
			if (epoch !== this.#epoch) return;
			this.#set({ phase: "done", record });
			this.#onDone?.(record);
		} catch (err) {
			if (epoch !== this.#epoch) return;
			this.#set({ phase: "failed", slug, message: describeConfirmError(err) });
		}
	}

	/** Back to idle; a pending native dialog's answer is ignored. */
	cancel(): void {
		this.#epoch++;
		this.#set({ phase: "idle" });
	}
}

export type UndoOutcome = { ok: true } | { ok: false; message: string };

/** Undo copy errors in plain words: 409 is the daemon's refusal because the copy changed or has commits. */
export async function undoMove(api: { undoMove(id: string): Promise<void> }, moveId: string): Promise<UndoOutcome> {
	try {
		await api.undoMove(moveId);
		return { ok: true };
	} catch (err) {
		if (err instanceof DeckApiError && err.status === 409) {
			return { ok: false, message: "Undo refused: the copy was edited or has commits, so omp console leaves it alone." };
		}
		return { ok: false, message: err instanceof Error ? err.message : "Undo failed." };
	}
}

export function canUndo(record: MoveRecord): boolean {
	return record.state === "done";
}

const STATE_LABEL: Record<MoveRecord["state"], string> = {
	prepared: "prepared",
	done: "copied",
	undone: "undone",
	failed: "failed",
};

export function moveStateLabel(state: MoveRecord["state"]): string {
	return STATE_LABEL[state];
}
