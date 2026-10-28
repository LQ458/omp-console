/**
 * Tiled panes: the framework-free model behind the pane host.
 *
 * Split of responsibility:
 * - `PaneModel` (here) owns WHICH panes exist, which session each shows, which one has focus and whether it is
 *   zoomed. It is the only writer of that state.
 * - Dockview (components/panes) owns WHERE the panes are: the grid, its sashes and their sizes. The model never
 *   mirrors the grid; it keeps the one relation it needs to rebuild a grid (a pane's `placement`) and, for
 *   persistence, an opaque copy of Dockview's serialized grid.
 * - Geometry questions (which pane is left of this one) are answered from the serialized grid with
 *   {@link rectsFromDock}, so they work on saved layouts and without a DOM.
 *
 * Invariants:
 * - There is always at least one pane. Closing the last one empties it (the pane then shows the home screen).
 * - `focusedId` always names an existing pane.
 * - Pane ids are never reused within a model's lifetime.
 */

export type PaneId = string;
export type Direction = "left" | "right" | "up" | "down";
/** Where a new pane goes relative to its reference: beside it (vsplit) or below it (hsplit). */
export type SplitAxis = "right" | "down";

export interface Placement {
	reference: PaneId;
	axis: SplitAxis;
}

export interface Pane {
	id: PaneId;
	/** Daemon session id (or a `link:` key from the guest pool); null for an empty pane. */
	sessionId: string | null;
	/** How this pane was split off; lets a grid be rebuilt when no saved grid exists. */
	placement?: Placement;
}

export interface PaneState {
	panes: readonly Pane[];
	focusedId: PaneId;
	/** The focused pane fills the area; the others are hidden but keep their sessions. */
	zoomed: boolean;
}

export interface Rect {
	left: number;
	top: number;
	width: number;
	height: number;
}

// ---- key bindings --------------------------------------------------------------------------------------

export type PaneAction =
	| { kind: "split"; axis: SplitAxis }
	| { kind: "focus"; direction: Direction }
	| { kind: "move"; direction: Direction }
	| { kind: "close" }
	| { kind: "zoom" };

export interface KeyLike {
	key: string;
	metaKey: boolean;
	ctrlKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
}

const ARROWS: Record<string, Direction> = {
	ArrowLeft: "left",
	ArrowRight: "right",
	ArrowUp: "up",
	ArrowDown: "down",
};

/**
 * Kitty `splits` bindings on the Mac Command key: D split right, Shift+D split down, Opt+arrows focus the
 * neighbour, Shift+arrows move (swap with) the neighbour, W close, Shift+Enter zoom. Anything else, including a
 * Ctrl chord, is not ours.
 */
export function paneKeyAction(e: KeyLike): PaneAction | null {
	if (!e.metaKey || e.ctrlKey) return null;
	const arrow = ARROWS[e.key];
	if (arrow !== undefined) {
		if (e.altKey && !e.shiftKey) return { kind: "focus", direction: arrow };
		if (e.shiftKey && !e.altKey) return { kind: "move", direction: arrow };
		return null;
	}
	if (e.altKey) return null;
	const key = e.key.toLowerCase();
	if (key === "d") return { kind: "split", axis: e.shiftKey ? "down" : "right" };
	if (key === "w" && !e.shiftKey) return { kind: "close" };
	if (e.key === "Enter" && e.shiftKey) return { kind: "zoom" };
	return null;
}

// ---- geometry ------------------------------------------------------------------------------------------

/** Pixel slack for sashes and rounding: edges closer than this count as touching. */
const EDGE_EPS = 2;

/**
 * The pane to move to from `from` in `direction`: among panes lying wholly beyond the near edge and overlapping
 * `from` along the other axis, the closest, then the one overlapping most (both within a couple of pixels), then
 * the one focused most recently (`recent`, newest first: a tall pane with two stacked neighbours goes back to the
 * one you were just in), then the one whose center is nearest. Null at the edge of the layout.
 */
export function neighbourOf(
	rects: ReadonlyMap<PaneId, Rect>,
	from: PaneId,
	direction: Direction,
	recent: readonly PaneId[] = [],
): PaneId | null {
	const a = rects.get(from);
	if (a === undefined) return null;
	const horizontal = direction === "left" || direction === "right";
	let best: Candidate | null = null;
	for (const [id, r] of rects) {
		if (id === from) continue;
		let gap: number;
		let overlap: number;
		let offset: number;
		if (horizontal) {
			gap = direction === "right" ? r.left - (a.left + a.width) : a.left - (r.left + r.width);
			overlap = Math.min(a.top + a.height, r.top + r.height) - Math.max(a.top, r.top);
			offset = Math.abs(a.top + a.height / 2 - (r.top + r.height / 2));
		} else {
			gap = direction === "down" ? r.top - (a.top + a.height) : a.top - (r.top + r.height);
			overlap = Math.min(a.left + a.width, r.left + r.width) - Math.max(a.left, r.left);
			offset = Math.abs(a.left + a.width / 2 - (r.left + r.width / 2));
		}
		if (gap < -EDGE_EPS || overlap <= EDGE_EPS) continue;
		const seen = recent.indexOf(id);
		const candidate: Candidate = { id, gap, overlap, offset, rank: seen === -1 ? Number.POSITIVE_INFINITY : seen };
		if (best === null || isBetter(candidate, best)) best = candidate;
	}
	return best?.id ?? null;
}

interface Candidate {
	id: PaneId;
	gap: number;
	overlap: number;
	offset: number;
	/** Index in the most-recently-focused list; infinity when never focused. */
	rank: number;
}

function isBetter(candidate: Candidate, best: Candidate): boolean {
	if (Math.abs(candidate.gap - best.gap) > EDGE_EPS) return candidate.gap < best.gap;
	if (Math.abs(candidate.overlap - best.overlap) > EDGE_EPS) return candidate.overlap > best.overlap;
	if (candidate.rank !== best.rank) return candidate.rank < best.rank;
	return candidate.offset < best.offset;
}

/** The slice of Dockview's `SerializedDockview` the geometry reads. */
export interface DockGrid {
	grid: {
		root: DockNode;
		width: number;
		height: number;
		orientation: "HORIZONTAL" | "VERTICAL";
	};
	panels: Record<string, unknown>;
}

export type DockNode =
	| { type: "leaf"; data: { views: string[] }; size?: number; visible?: boolean }
	| { type: "branch"; data: DockNode[]; size?: number; visible?: boolean };

/**
 * Rectangles of every pane in a serialized Dockview grid (one pane per group; a group holding several panels
 * counts its first). Children of a branch are laid out along its orientation using their `size`; the cross axis
 * is the branch's own extent. Null when the grid is malformed.
 */
export function rectsFromDock(dock: DockGrid): Map<PaneId, Rect> | null {
	const rects = new Map<PaneId, Rect>();
	const ok = walk(dock.grid.root, { left: 0, top: 0, width: dock.grid.width, height: dock.grid.height }, dock.grid.orientation, rects);
	return ok ? rects : null;
}

function walk(node: DockNode, rect: Rect, orientation: "HORIZONTAL" | "VERTICAL", out: Map<PaneId, Rect>): boolean {
	if (node.type === "leaf") {
		const id = node.data?.views?.[0];
		if (typeof id !== "string") return false;
		out.set(id, rect);
		return true;
	}
	if (!Array.isArray(node.data)) return false;
	const along = orientation === "HORIZONTAL";
	const children = node.data.filter(child => child.visible !== false);
	let offset = 0;
	for (const child of children) {
		const size = typeof child.size === "number" ? child.size : 0;
		const childRect: Rect = along
			? { left: rect.left + offset, top: rect.top, width: size, height: rect.height }
			: { left: rect.left, top: rect.top + offset, width: rect.width, height: size };
		offset += size;
		if (!walk(child, childRect, along ? "VERTICAL" : "HORIZONTAL", out)) return false;
	}
	return true;
}

// ---- persistence ---------------------------------------------------------------------------------------

export const LAYOUT_VERSION = 1;
/** The window's auto-saved layout lives under this name; menu layouts use their own names. */
export const CURRENT_LAYOUT = "current";
const LAYOUT_PREFIX = "omp-console-layout:";

export interface SavedLayout {
	v: typeof LAYOUT_VERSION;
	panes: Pane[];
	focusedId: PaneId;
	/** Dockview's serialized grid, kept only when it describes exactly these panes. */
	dock?: DockGrid;
}

/** The storage surface layouts need; `localStorage` satisfies it. */
export type LayoutStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePane(raw: unknown): Pane | null {
	if (!isRecord(raw) || typeof raw.id !== "string" || raw.id === "") return null;
	const sessionId = raw.sessionId;
	if (sessionId !== null && typeof sessionId !== "string") return null;
	// A `link:` key names an in-memory joined room whose link (a secret) is never stored: it cannot be restored.
	const pane: Pane = { id: raw.id, sessionId: typeof sessionId === "string" && !sessionId.startsWith("link:") ? sessionId : null };
	const placement = raw.placement;
	if (isRecord(placement) && typeof placement.reference === "string" && (placement.axis === "right" || placement.axis === "down")) {
		pane.placement = { reference: placement.reference, axis: placement.axis };
	}
	return pane;
}

function dockMatches(dock: unknown, paneIds: ReadonlySet<PaneId>): dock is DockGrid {
	if (!isRecord(dock) || !isRecord(dock.grid) || !isRecord(dock.panels)) return false;
	const keys = Object.keys(dock.panels);
	if (keys.length !== paneIds.size || !keys.every(key => paneIds.has(key))) return false;
	const grid = dock.grid;
	if (typeof grid.width !== "number" || typeof grid.height !== "number" || !isRecord(grid.root)) return false;
	if (grid.orientation !== "HORIZONTAL" && grid.orientation !== "VERTICAL") return false;
	const rects = rectsFromDock(dock as unknown as DockGrid);
	return rects !== null && rects.size === paneIds.size && [...rects.keys()].every(id => paneIds.has(id));
}

/** Validates stored text; anything not exactly a layout this version wrote is rejected (null). */
export function parseSavedLayout(text: string | null): SavedLayout | null {
	if (text === null) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isRecord(raw) || raw.v !== LAYOUT_VERSION || !Array.isArray(raw.panes) || raw.panes.length === 0) return null;
	const panes: Pane[] = [];
	for (const item of raw.panes) {
		const pane = parsePane(item);
		if (pane === null) return null;
		panes.push(pane);
	}
	const ids = new Set(panes.map(pane => pane.id));
	if (ids.size !== panes.length) return null;
	for (const pane of panes) {
		if (pane.placement && (!ids.has(pane.placement.reference) || pane.placement.reference === pane.id)) delete pane.placement;
	}
	const focusedId = typeof raw.focusedId === "string" && ids.has(raw.focusedId) ? raw.focusedId : panes[0]!.id;
	const layout: SavedLayout = { v: LAYOUT_VERSION, panes, focusedId };
	if (dockMatches(raw.dock, ids)) layout.dock = raw.dock;
	return layout;
}

function layoutKey(name: string): string {
	return `${LAYOUT_PREFIX}${name}`;
}

export function readLayout(storage: LayoutStorage | undefined, name: string): SavedLayout | null {
	if (!storage) return null;
	try {
		return parseSavedLayout(storage.getItem(layoutKey(name)));
	} catch {
		return null;
	}
}

/** False when storage refused the write (full, blocked). */
export function writeLayout(storage: LayoutStorage | undefined, name: string, layout: SavedLayout): boolean {
	if (!storage) return false;
	try {
		storage.setItem(layoutKey(name), JSON.stringify(layout));
		return true;
	} catch {
		return false;
	}
}

export function deleteLayout(storage: LayoutStorage | undefined, name: string): void {
	try {
		storage?.removeItem(layoutKey(name));
	} catch {
		// nothing to delete
	}
}

/** Names of the saved menu layouts (not the auto-saved current one), sorted. Unreadable entries are skipped. */
export function listLayouts(storage: LayoutStorage | undefined): string[] {
	if (!storage) return [];
	const names: string[] = [];
	try {
		for (let i = 0; i < storage.length; i++) {
			const key = storage.key(i);
			if (key === null || !key.startsWith(LAYOUT_PREFIX)) continue;
			const name = key.slice(LAYOUT_PREFIX.length);
			if (name !== CURRENT_LAYOUT && readLayout(storage, name) !== null) names.push(name);
		}
	} catch {
		return names.sort();
	}
	return names.sort((a, b) => a.localeCompare(b));
}

/** A layout name the user typed: trimmed, non-empty, not the reserved auto-save name. Null when unusable. */
export function normalizeLayoutName(input: string): string | null {
	const name = input.trim().replace(/\s+/g, " ").slice(0, 48);
	return name === "" || name === CURRENT_LAYOUT ? null : name;
}

// ---- the model -----------------------------------------------------------------------------------------

/**
 * Sessions to empty out of the panes after the daemon's list arrives: shown by a pane, not live now, and either
 * seen live before (it stopped) or restored from a saved layout (the first list decides). A session created a
 * moment ago may be missing from a list fetched before it existed, so "never seen live" alone is not stale.
 * Joined rooms are not daemon sessions and are never stale here.
 */
export function staleSessions(
	shown: readonly string[],
	live: ReadonlySet<string>,
	seenLive: ReadonlySet<string>,
	firstList: boolean,
	preserved: ReadonlySet<string> = new Set(),
): Set<string> {
	const stale = new Set<string>();
	for (const id of shown) {
		if (id.startsWith("link:") || live.has(id) || seenLive.has(id) || preserved.has(id)) continue;
		if (firstList) stale.add(id);
	}
	return stale;
}

export type PaneRecoveryStatus = "reconnecting" | "stopped";

export function paneRecoveryStatus(lastLiveAt: number | undefined, now: number, reconnectWindowMs = 60_000): PaneRecoveryStatus | null {
	if (lastLiveAt === undefined) return null;
	return now - lastLiveAt <= reconnectWindowMs ? "reconnecting" : "stopped";
}

export type PaneIdFactory = () => PaneId;

function counterFactory(start: number): PaneIdFactory {
	let next = start;
	return () => `p${next++}`;
}

function nextCounter(panes: readonly Pane[]): number {
	let max = 0;
	for (const pane of panes) {
		const match = /^p(\d+)$/.exec(pane.id);
		if (match) max = Math.max(max, Number(match[1]));
	}
	return max + 1;
}

export class PaneModel {
	readonly #listeners = new Set<() => void>();
	#newId: PaneIdFactory;
	#state: PaneState;
	/** Most recently focused first; closing a pane returns focus to the previous entry. */
	#recent: PaneId[];
	/** A saved grid waiting for the host to apply it (restore, named layout); taken exactly once. */
	#pendingDock: DockGrid | undefined;

	constructor(initial?: SavedLayout, newId?: PaneIdFactory) {
		if (initial) {
			this.#state = { panes: initial.panes.map(pane => ({ ...pane })), focusedId: initial.focusedId, zoomed: false };
			this.#newId = newId ?? counterFactory(nextCounter(initial.panes));
		} else {
			this.#newId = newId ?? counterFactory(1);
			const first: Pane = { id: this.#newId(), sessionId: null };
			this.#state = { panes: [first], focusedId: first.id, zoomed: false };
		}
		this.#recent = [this.#state.focusedId];
		this.#pendingDock = initial?.dock;
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	getSnapshot(): PaneState {
		return this.#state;
	}

	get focused(): Pane {
		return this.#state.panes.find(pane => pane.id === this.#state.focusedId)!;
	}

	/** Distinct non-empty session ids shown by any pane: what the guest pool must keep connected. */
	sessionIds(): string[] {
		const ids = new Set<string>();
		for (const pane of this.#state.panes) if (pane.sessionId !== null) ids.add(pane.sessionId);
		return [...ids];
	}

	/**
	 * Shows `sessionId`. Plain open (`"focused"`): a session already visible in some pane takes focus there,
	 * otherwise it replaces the focused pane's session. A split target always creates a new pane beside or below
	 * the focused one, even when the session is already open (two views of one session share one connection).
	 */
	open(sessionId: string, target: "focused" | SplitAxis = "focused"): PaneId {
		if (target === "focused") {
			const showing = this.#state.panes.find(pane => pane.sessionId === sessionId);
			if (showing) {
				this.focus(showing.id);
				return showing.id;
			}
			const id = this.#state.focusedId;
			this.#patch({ panes: this.#state.panes.map(pane => (pane.id === id ? { ...pane, sessionId } : pane)) });
			return id;
		}
		return this.#insert(target, sessionId);
	}

	/** Splits the focused pane; the new pane is empty and takes focus. */
	split(axis: SplitAxis): PaneId {
		return this.#insert(axis, null);
	}

	#insert(axis: SplitAxis, sessionId: string | null): PaneId {
		const reference = this.#state.focusedId;
		const id = this.#newId();
		const at = this.#state.panes.findIndex(pane => pane.id === reference);
		const panes = [...this.#state.panes];
		panes.splice(at + 1, 0, { id, sessionId, placement: { reference, axis } });
		this.#recent = [id, ...this.#recent.filter(entry => entry !== id)];
		this.#patch({ panes, focusedId: id, zoomed: false });
		return id;
	}

	/** Closes a pane; the sole pane is emptied instead (home screen). Focus returns to the previous pane. */
	close(id: PaneId = this.#state.focusedId): void {
		const { panes } = this.#state;
		if (!panes.some(pane => pane.id === id)) return;
		if (panes.length === 1) {
			this.#patch({ panes: [{ id: panes[0]!.id, sessionId: null }], zoomed: false });
			return;
		}
		const remaining = panes.filter(pane => pane.id !== id).map(pane => this.#reanchor(pane, id, panes));
		this.#recent = this.#recent.filter(entry => entry !== id);
		const wasFocused = this.#state.focusedId === id;
		const focusedId = wasFocused
			? (this.#recent.find(entry => remaining.some(pane => pane.id === entry)) ?? remaining[0]!.id)
			: this.#state.focusedId;
		this.#recent = [focusedId, ...this.#recent.filter(entry => entry !== focusedId)];
		this.#patch({ panes: remaining, focusedId, zoomed: this.#state.zoomed && !wasFocused && remaining.length > 1 });
	}

	/** A pane split off the closed one is re-anchored to the closed pane's own reference, or loses its placement. */
	#reanchor(pane: Pane, closedId: PaneId, before: readonly Pane[]): Pane {
		if (pane.placement?.reference !== closedId) return pane;
		const closed = before.find(entry => entry.id === closedId);
		const reference = closed?.placement?.reference;
		if (reference !== undefined && reference !== pane.id) return { ...pane, placement: { ...pane.placement, reference } };
		const { placement: _dropped, ...rest } = pane;
		return rest;
	}

	focus(id: PaneId): void {
		if (id === this.#state.focusedId || !this.#state.panes.some(pane => pane.id === id)) return;
		this.#recent = [id, ...this.#recent.filter(entry => entry !== id)];
		this.#patch({ focusedId: id });
	}

	/** Next (or previous) pane in creation order, wrapping: the phone pane switcher. */
	cycle(step: 1 | -1): void {
		const { panes, focusedId } = this.#state;
		const at = panes.findIndex(pane => pane.id === focusedId);
		this.focus(panes[(at + step + panes.length) % panes.length]!.id);
	}

	/** Moves focus to the geometric neighbour; leaves zoom first. False at the edge of the layout. */
	focusDirection(rects: ReadonlyMap<PaneId, Rect>, direction: Direction): boolean {
		const target = neighbourOf(rects, this.#state.focusedId, direction, this.#recent);
		if (target === null) return false;
		if (this.#state.zoomed) this.#patch({ zoomed: false });
		this.focus(target);
		return true;
	}

	/**
	 * Swaps the focused pane's session with its neighbour's (kitty `move_window`); focus follows the content.
	 * Panes are slots, so the grid does not change. False at the edge of the layout.
	 */
	moveDirection(rects: ReadonlyMap<PaneId, Rect>, direction: Direction): boolean {
		const from = this.#state.focusedId;
		const target = neighbourOf(rects, from, direction, this.#recent);
		if (target === null) return false;
		const a = this.#state.panes.find(pane => pane.id === from)!;
		const b = this.#state.panes.find(pane => pane.id === target)!;
		const panes = this.#state.panes.map(pane =>
			pane.id === from ? { ...pane, sessionId: b.sessionId } : pane.id === target ? { ...pane, sessionId: a.sessionId } : pane,
		);
		this.#recent = [target, ...this.#recent.filter(entry => entry !== target)];
		this.#patch({ panes, focusedId: target });
		return true;
	}

	toggleZoom(): void {
		this.setZoomed(!this.#state.zoomed);
	}

	/** Zoom needs two panes to mean anything; unzooming is always allowed. */
	setZoomed(zoomed: boolean): void {
		if (zoomed === this.#state.zoomed || (zoomed && this.#state.panes.length < 2)) return;
		this.#patch({ zoomed });
	}

	/** The saved grid to apply to the Dockview instance, once; undefined when there is none or it was taken. */
	takePendingDock(): DockGrid | undefined {
		const dock = this.#pendingDock;
		this.#pendingDock = undefined;
		return dock;
	}

	/** Empties every pane whose session `keep` rejects (stopped, or unknown after a restore). */
	dropSessions(keep: (sessionId: string) => boolean): void {
		let changed = false;
		const panes = this.#state.panes.map(pane => {
			if (pane.sessionId === null || keep(pane.sessionId)) return pane;
			changed = true;
			return { ...pane, sessionId: null };
		});
		if (changed) this.#patch({ panes });
	}

	/** Replaces everything with a saved layout (named layout menu). Zoom resets. */
	load(layout: SavedLayout): void {
		this.#newId = counterFactory(Math.max(nextCounter(layout.panes), nextCounter(this.#state.panes)));
		this.#recent = [layout.focusedId];
		this.#pendingDock = layout.dock;
		this.#patch({ panes: layout.panes.map(pane => ({ ...pane })), focusedId: layout.focusedId, zoomed: false });
	}

	/** The state to persist; `dock` is Dockview's serialized grid when one is mounted. */
	toSaved(dock?: unknown): SavedLayout {
		const { panes, focusedId } = this.#state;
		const saved: SavedLayout = { v: LAYOUT_VERSION, panes: panes.map(pane => ({ ...pane })), focusedId };
		if (dockMatches(dock, new Set(panes.map(pane => pane.id)))) saved.dock = dock;
		return saved;
	}

	#patch(partial: Partial<PaneState>): void {
		this.#state = { ...this.#state, ...partial };
		for (const listener of this.#listeners) listener();
	}
}
