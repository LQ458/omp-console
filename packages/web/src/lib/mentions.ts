/**
 * Composer mention syntax, spec 5.1, 5.3, 5.6. Pure text logic plus a debounced, stale-safe loader: the textarea holds
 * plain `@path`, `^provider/id` and `/command` text and omp itself expands it on submit, so the only job here is to
 * find the token under the caret, build the replacement, and map dropped files onto the same syntax.
 * Quoting follows omp's own parser (`packages/coding-agent/src/utils/file-mentions.ts`): `@"a b"`, `@'a b'`, or bare
 * `@path` when the path has no whitespace or `@`.
 */

export type MentionKind = "file" | "model" | "command";

export interface MentionTrigger {
	kind: MentionKind;
	/** Index of the `@`, `^` or `/` that opens the token. */
	start: number;
	/** End of the text the accepted suggestion replaces (caret, or the end of the token when the caret is inside it). */
	end: number;
	/** Text typed after the sigil (after the quote for a quoted file mention). */
	query: string;
	quoted: boolean;
}

/** Characters omp accepts in front of `@` (see `MENTION_BOUNDARY_REGEX` in file-mentions.ts). */
const BOUNDARY = /[\s([{<"'`]/;
const SPACE = /\s/;

function isBoundary(text: string, index: number): boolean {
	return index === 0 || BOUNDARY.test(text[index - 1] ?? "");
}

function tokenEnd(text: string, from: number): number {
	let end = from;
	while (end < text.length && !SPACE.test(text[end] ?? "")) end++;
	return end;
}

function quotedFileTrigger(text: string, caret: number): MentionTrigger | null {
	for (const quote of ['"', "'"]) {
		const open = text.lastIndexOf(`@${quote}`, caret - 2);
		if (open < 0 || open + 2 > caret || !isBoundary(text, open)) continue;
		const typed = text.slice(open + 2, caret);
		if (typed.includes(quote) || typed.includes("\n")) continue;
		const close = text.indexOf(quote, caret);
		const lineEnd = text.indexOf("\n", caret);
		const closed = close >= 0 && (lineEnd < 0 || close < lineEnd);
		return { kind: "file", start: open, end: closed ? close + 1 : caret, query: typed, quoted: true };
	}
	return null;
}

/**
 * The mention token the caret is in, or null. `@` and `^` open at any token start; `/` only when it starts the
 * composer (leading whitespace allowed) and the caret is still inside the command name.
 */
export function findMentionTrigger(text: string, caret: number): MentionTrigger | null {
	const at = Math.max(0, Math.min(caret, text.length));
	const quoted = quotedFileTrigger(text, at);
	if (quoted) return quoted;

	let tokenStart = at;
	while (tokenStart > 0 && !SPACE.test(text[tokenStart - 1] ?? "")) tokenStart--;

	for (let i = at - 1; i >= tokenStart; i--) {
		const ch = text[i];
		if ((ch === "@" || ch === "^") && isBoundary(text, i)) {
			return {
				kind: ch === "@" ? "file" : "model",
				start: i,
				end: tokenEnd(text, at),
				query: text.slice(i + 1, at),
				quoted: false,
			};
		}
	}

	if (text[tokenStart] === "/" && text.slice(0, tokenStart).trim() === "") {
		return {
			kind: "command",
			start: tokenStart,
			end: tokenEnd(text, at),
			query: text.slice(tokenStart + 1, at),
			quoted: false,
		};
	}
	return null;
}

/**
 * `@path`, quoted when the path has whitespace or `@`. `open` leaves a quoted mention unclosed so the caret stays
 * inside it (a directory whose children are suggested next).
 */
export function formatFileMention(path: string, open = false): string {
	if (!/[\s@]/.test(path)) return `@${path}`;
	const quote = !path.includes('"') ? '"' : !path.includes("'") ? "'" : null;
	if (quote === null) return `@${path}`;
	return open ? `@${quote}${path}` : `@${quote}${path}${quote}`;
}

export function formatModelMention(selector: string): string {
	return `^${selector}`;
}

export interface Insertion {
	text: string;
	caret: number;
}

/** Replaces the trigger's token with `replacement`; `space` appends one separator unless the text already has one. */
export function applyMention(text: string, trigger: MentionTrigger, replacement: string, space: boolean): Insertion {
	const before = text.slice(0, trigger.start);
	const after = text.slice(trigger.end);
	const sep = space && !/^\s/.test(after) ? " " : "";
	const inserted = replacement + sep;
	const next = before + inserted + after;
	const caret = before.length + inserted.length + (space && sep === "" && /^\s/.test(after) ? 1 : 0);
	return { text: next, caret };
}

/**
 * Inserts `insertion` over the selection `[from, to)`, separated from neighbouring text by a space on each side
 * (none at the start or end of the text, none next to existing whitespace). Used for drops and external inserts.
 */
export function insertAtSelection(text: string, from: number, to: number, insertion: string): Insertion {
	const before = text.slice(0, from);
	const after = text.slice(to);
	const lead = before !== "" && !/\s$/.test(before) ? " " : "";
	const trail = /^\s/.test(after) ? "" : " ";
	const inserted = lead + insertion + trail;
	const caret = before.length + inserted.length + (trail === "" ? 1 : 0);
	return { text: before + inserted + after, caret };
}

// ---- drop mapping (5.6) --------------------------------------------------------------------

export const PROMPT_IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function dotSegments(path: string): string[] {
	const out: string[] = [];
	for (const part of path.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") out.pop();
		else out.push(part);
	}
	return out;
}

/** Path of `absolute` relative to `cwd`, or null when it lies outside. The cwd itself maps to `.`. */
export function relativeToCwd(absolute: string, cwd: string): string | null {
	if (!absolute.startsWith("/") || !cwd.startsWith("/")) return null;
	const target = dotSegments(absolute);
	const root = dotSegments(cwd);
	if (target.length < root.length) return null;
	for (let i = 0; i < root.length; i++) if (target[i] !== root[i]) return null;
	const rest = target.slice(root.length);
	if (rest.length === 0) return ".";
	return rest.join("/") + (absolute.endsWith("/") ? "/" : "");
}

/** `@relative/path` inside the session cwd; `@"/absolute/path"` (always quoted) outside it. */
export function formatDroppedPath(absolute: string, cwd: string | undefined): string {
	const relative = cwd === undefined ? null : relativeToCwd(absolute, cwd);
	if (relative !== null) return formatFileMention(relative);
	const quote = !absolute.includes('"') ? '"' : !absolute.includes("'") ? "'" : null;
	return quote === null ? `@${absolute}` : `@${quote}${absolute}${quote}`;
}

/** Absolute paths from `file://` URLs, one per line; every other line (comments, prose, http URLs) is ignored. */
export function parseFileUris(text: string): string[] {
	const paths: string[] = [];
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line.startsWith("file://")) continue;
		try {
			const url = new URL(line);
			if (url.hostname !== "" && url.hostname !== "localhost") continue;
			paths.push(decodeURIComponent(url.pathname));
		} catch {
			// malformed URI: skip
		}
	}
	return paths;
}

export interface DroppedFile {
	name: string;
	type: string;
}

export interface DropInput {
	/** `dataTransfer.getData("text/uri-list")`. */
	uriList: string;
	/** `dataTransfer.getData("text/plain")`. */
	text: string;
	files: readonly DroppedFile[];
}

export interface DropPlan {
	/** Paths to insert as mentions (images that will be attached are not listed here). */
	mentionPaths: string[];
	/** Supported image files; `path` is the dragged file's location when the drop carried it. */
	images: { index: number; path?: string }[];
	/** Non-image files and their exposed local path, when available. */
	nonImages: { index: number; path?: string }[];
	/** Exposed local paths without a matching File payload. */
	unmatchedPaths: string[];
}

function baseName(path: string): string {
	const parts = path.split("/").filter(part => part !== "");
	return parts[parts.length - 1] ?? "";
}

/** Splits one drop into mention paths, prompt images, and files whose path the browser hid. */
export function planDrop(input: DropInput): DropPlan {
	const seen = new Set<string>();
	const paths: string[] = [];
	for (const path of [...parseFileUris(input.uriList), ...parseFileUris(input.text)]) {
		if (seen.has(path)) continue;
		seen.add(path);
		paths.push(path);
	}
	const claimed = new Set<string>();
	const claim = (name: string): string | undefined => {
		const hit = paths.find(path => !claimed.has(path) && baseName(path) === name);
		if (hit !== undefined) claimed.add(hit);
		return hit;
	};
	const images: DropPlan["images"] = [];
	const nonImages: DropPlan["nonImages"] = [];
	input.files.forEach((file, index) => {
		const path = claim(file.name);
		if (PROMPT_IMAGE_TYPES.has(file.type)) images.push({ index, path });
		else nonImages.push({ index, path });
	});
	const imagePaths = new Set(images.flatMap(image => (image.path === undefined ? [] : [image.path])));
	return {
		mentionPaths: paths.filter(path => !imagePaths.has(path)),
		images,
		nonImages,
		unmatchedPaths: paths.filter(path => !claimed.has(path)),
	};
}

// ---- debounced, stale-safe loading -------------------------------------------------------------

export interface SuggestionLoaderOptions<T> {
	load(query: string, signal: AbortSignal): Promise<T>;
	onResult(query: string, value: T): void;
	onError(query: string, error: unknown): void;
	delayMs?: number;
	/** Arms a one-shot timer and returns its canceller (tests inject a manual clock). */
	schedule?: (fn: () => void, ms: number) => () => void;
}

export const SUGGESTION_DEBOUNCE_MS = 80;

function defaultSchedule(fn: () => void, ms: number): () => void {
	const handle = setTimeout(fn, ms);
	return () => clearTimeout(handle);
}

/**
 * Debounces lookups and drops everything but the newest: a superseded request is aborted, and even a loader that
 * ignores its signal cannot deliver a stale result or error.
 */
export class SuggestionLoader<T> {
	readonly #options: SuggestionLoaderOptions<T>;
	#cancelTimer: (() => void) | null = null;
	#controller: AbortController | null = null;
	#generation = 0;

	constructor(options: SuggestionLoaderOptions<T>) {
		this.#options = options;
	}

	request(query: string): void {
		this.cancel();
		const generation = this.#generation;
		const schedule = this.#options.schedule ?? defaultSchedule;
		this.#cancelTimer = schedule(() => {
			this.#cancelTimer = null;
			const controller = new AbortController();
			this.#controller = controller;
			void this.#options.load(query, controller.signal).then(
				value => {
					if (generation === this.#generation && !controller.signal.aborted) this.#options.onResult(query, value);
				},
				error => {
					if (generation === this.#generation && !controller.signal.aborted) this.#options.onError(query, error);
				},
			);
		}, this.#options.delayMs ?? SUGGESTION_DEBOUNCE_MS);
	}

	/** Drops the pending timer and aborts the in-flight request; later results are ignored. */
	cancel(): void {
		this.#generation++;
		this.#cancelTimer?.();
		this.#cancelTimer = null;
		this.#controller?.abort();
		this.#controller = null;
	}
}
