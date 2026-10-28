import {
	OMP_CONSOLE_SESSION_URL_PREFIX,
	type AgendaAskResponse,
	type AgendaItem,
	type AgendaToday,
} from "@omp-console/protocol";
import { errorResponse, json } from "../api";
import askSystemAddendum from "./ask-system-addendum.md" with { type: "text" };
import { runBoardIo } from "./board-io";
import { type AgendaHubConfig, AgendaAskError, type AgendaPorts, type AgendaRouteOptions } from "./ports";

const TODAY_ROUTE = "/api/agenda/today";
const TODOS_ROUTE = "/api/agenda/todos";
const ASK_ROUTE = "/api/agenda/ask";
const BOARD_DUMP_ARGS = ["-m", "hub.board_io", "dump"];
const BOARD_CREATE_ARGS = ["-m", "hub.board_io", "create"];
const BOARD_WRITE_ARGS = ["-m", "hub.board_io", "write"];
const DEFAULT_TIME_ZONE = "America/Chicago";

interface HubTask {
	id: string;
	title: string;
	list: string;
	priority?: number;
	due?: number | null;
	notes?: string;
	url?: string | null;
	completed?: boolean;
}


interface HubDump {
	lists: string[];
	items: HubTask[];
}

class AgendaRequestError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHubDump(output: string): HubDump {
	let value: unknown;
	try {
		value = JSON.parse(output);
	} catch {
		throw new Error("tasks-hub returned invalid JSON");
	}
	if (!isRecord(value) || !Array.isArray(value.lists) || !Array.isArray(value.items)) {
		throw new Error("tasks-hub returned invalid data");
	}
	const lists: string[] = [];
	for (const list of value.lists) {
		if (typeof list !== "string") throw new Error("tasks-hub returned invalid data");
		lists.push(list);
	}
	const items: HubTask[] = [];
	for (const item of value.items) {
		if (!isRecord(item) || typeof item.id !== "string" || typeof item.title !== "string" || typeof item.list !== "string") {
			throw new Error("tasks-hub returned invalid data");
		}
		if (item.due !== undefined && item.due !== null && (typeof item.due !== "number" || !Number.isFinite(item.due))) {
			throw new Error("tasks-hub returned invalid data");
		}
		if (item.priority !== undefined && (typeof item.priority !== "number" || !Number.isInteger(item.priority))) {
			throw new Error("tasks-hub returned invalid data");
		}
		if (item.notes !== undefined && typeof item.notes !== "string") throw new Error("tasks-hub returned invalid data");
		if (item.url !== undefined && item.url !== null && typeof item.url !== "string") throw new Error("tasks-hub returned invalid data");
		if (item.completed !== undefined && typeof item.completed !== "boolean") throw new Error("tasks-hub returned invalid data");
		items.push({
			id: item.id,
			title: item.title,
			list: item.list,
			...(item.priority === undefined ? {} : { priority: item.priority as number }),
			...(item.due === undefined ? {} : { due: item.due as number | null }),
			...(item.notes === undefined ? {} : { notes: item.notes }),
			...(item.url === undefined ? {} : { url: item.url as string | null }),
			...(item.completed === undefined ? {} : { completed: item.completed }),
		});
	}
	return { lists, items };
}

function dateParts(epochMs: number, timeZone: string): Map<string, string> {
	const parts = new Intl.DateTimeFormat("en-US-u-ca-iso8601-nu-latn", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).formatToParts(new Date(epochMs));
	return new Map(parts.map(part => [part.type, part.value]));
}

function part(parts: Map<string, string>, name: string): string {
	const value = parts.get(name);
	if (!value) throw new Error(`missing ${name} date part`);
	return value;
}

function localDay(epochMs: number, timeZone: string): string {
	const parts = dateParts(epochMs, timeZone);
	return `${part(parts, "year")}-${part(parts, "month")}-${part(parts, "day")}`;
}

function hubDue(epochMs: number | undefined, timeZone: string): { date: string; time: string } | null {
	if (epochMs === undefined) return null;
	if (!Number.isFinite(epochMs) || !Number.isFinite(new Date(epochMs).getTime())) {
		throw new AgendaRequestError("due must be an epoch-millisecond timestamp");
	}
	const parts = dateParts(epochMs, timeZone);
	return {
		date: `${part(parts, "year")}-${part(parts, "month")}-${part(parts, "day")}`,
		time: `${part(parts, "hour")}:${part(parts, "minute")}`,
	};
}

function sessionUrl(task: HubTask): string | undefined {
	return typeof task.url === "string" && task.url.startsWith(OMP_CONSOLE_SESSION_URL_PREFIX) ? task.url : undefined;
}

function sessionIdFromUrl(url: string): string | undefined {
	const encoded = url.slice(OMP_CONSOLE_SESSION_URL_PREFIX.length).split(/[/?#]/, 1)[0];
	if (!encoded) return undefined;
	try {
		const decoded = decodeURIComponent(encoded);
		return decoded.length > 0 && !decoded.includes("/") && !decoded.includes("\\") ? decoded : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The Ask answer: the model's reply, then one daemon-written line per task the ask completed, so a completion is never
 * hidden by what the model chose to say. Titles lose `*` and line breaks so they cannot break out of the bold mark.
 */
export function askAnswerWithReceipt(reply: string | undefined, completed: ReadonlyArray<{ title: string; uncertain?: true }>): string {
	const receipt = completed
		.map(task => {
			// Format characters (bidi controls, zero-width, soft hyphen) go; a title with nothing visible left is untitled.
			// Keeps ZWJ (emoji sequences); fillers that Unicode calls letters (Hangul fillers, braille blank) count as blank.
			const title = task.title.replace(/(?!\u200d)\p{Cf}/gu, "").replace(/[*\s]+/gu, " ").trim();
			const visible = /[\p{L}\p{N}\p{S}\p{P}]/u.test(title.replace(/[\u115f\u1160\u2800\u3164\uffa0\u200d]/gu, ""));
			const points = Array.from(title);
			const shown = points.length > 200 ? `${points.slice(0, 199).join("")}…` : title;
			const label = task.uncertain ? "⚠ May have been marked done (check the board)" : "✓ Marked done";
			return `${label}: **${visible ? shown : "(untitled task)"}**`;
		})
		.join("\n");
	return [reply?.trim(), receipt].filter(Boolean).join("\n\n");
}

/** `YYYY-MM-DD` `days` calendar days after the local day of `now` (calendar arithmetic: DST days are 23 or 25 h). */
function localDayPlus(now: number, timeZone: string, days: number): string {
	const [year, month, day] = localDay(now, timeZone).split("-").map(Number) as [number, number, number];
	return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** Open tasks due today or overdue, or within `days` more days, plus every session-linked task. */
function mapToday(dump: HubDump, now: number, timeZone: string, days = 0): AgendaItem[] {
	const today = localDayPlus(now, timeZone, days);
	const result: AgendaItem[] = [];
	for (const task of dump.items) {
		const sessionLink = sessionUrl(task);
		const sessionId = sessionLink ? sessionIdFromUrl(sessionLink) : undefined;
		const due = task.due == null ? undefined : task.due * 1000;
		const linked = sessionLink !== undefined && sessionId !== undefined;
		const dueTodayOrOverdue =
			task.completed !== true && due !== undefined && localDay(due, timeZone) <= today;
		if (!linked && !dueTodayOrOverdue) continue;
		result.push({
			uid: task.id,
			title: task.title,
			list: task.list,
			completed: task.completed ?? false,
			...(due === undefined ? {} : { due }),
			...(linked ? { url: sessionLink, sessionId } : {}),
			...(task.notes === undefined ? {} : { notes: task.notes }),
		});
	}
	return result;
}

function unavailable(reason: string): Response {
	const body: AgendaToday = { items: [], available: false, reason };
	return json(200, body);
}

function methodNotAllowed(req: Request, method: string): Response {
	return errorResponse(405, "bad-request", `method ${req.method} not allowed`, { Allow: method });
}

async function readBody(req: Request): Promise<Record<string, unknown> | undefined> {
	try {
		const value: unknown = await req.json();
		return isRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function defaultList(dump: HubDump): string | undefined {
	return dump.lists[0];
}

function taskExpectation(task: HubTask): Record<string, unknown> | undefined {
	if (task.priority === undefined) return undefined;
	return {
		title: task.title,
		due: task.due ?? null,
		priority: task.priority,
		list: task.list,
		url: task.url ?? null,
	};
}

function linkedAgendaItem(task: HubTask, sessionId: string): AgendaItem {
	return {
		uid: task.id,
		title: task.title,
		list: task.list,
		completed: false,
		...(task.due == null ? {} : { due: task.due * 1000 }),
		url: `${OMP_CONSOLE_SESSION_URL_PREFIX}${encodeURIComponent(sessionId)}`,
		sessionId,
		...(task.notes === undefined ? {} : { notes: task.notes }),
	};
}

function readWriteResult(output: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(output);
		return isRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function writeFailure(error: unknown): Response {
	if (error === "changed since the board last read it") {
		return errorResponse(409, "conflict", "task changed; refresh the agenda and try again");
	}
	if (error === "reminder not found") return errorResponse(404, "not-found", "agenda task no longer exists");
	if (error === "bad request" || error === "bad value") {
		return errorResponse(400, "bad-request", "tasks-hub rejected the agenda update");
	}
	return errorResponse(502, "internal", "tasks-hub could not save the agenda task");
}

/** A dump this fresh is served as is. */
const DUMP_FRESH_MS = 30_000;
/** A dump up to this old is served at once while a refresh runs behind it (and when tasks-hub is briefly down). */
const DUMP_STALE_MS = 10 * 60_000;

interface DumpCache {
	dump?: HubDump;
	at: number;
	/** A write went through since `dump` was read: the next read waits for a fresh dump. */
	dirty: boolean;
	pending?: Promise<HubDump>;
}

/**
 * One tasks-hub dump costs a Python start plus a CalDAV round trip (~1.4 s from the Mac), and the home screen, the
 * return brief and every session header poll read it. Reads share one cache per hub: fresh is served, stale is served
 * while one refresh runs, and a write marks it dirty so the next read sees the write.
 */
const dumpCaches = new WeakMap<AgendaHubConfig, DumpCache>();

function dumpCache(hub: AgendaHubConfig): DumpCache {
	let cache = dumpCaches.get(hub);
	if (!cache) {
		cache = { at: 0, dirty: false };
		dumpCaches.set(hub, cache);
	}
	return cache;
}

function refreshDump(hub: AgendaHubConfig, run: typeof runBoardIo, now: () => number): Promise<HubDump> {
	const cache = dumpCache(hub);
	if (cache.pending) return cache.pending;
	const startedDirty = cache.dirty;
	const pending = run(hub, BOARD_DUMP_ARGS)
		.then(output => {
			const dump = parseHubDump(output);
			cache.dump = dump;
			cache.at = now();
			// A write that landed while this read ran keeps the cache dirty for the next read.
			if (startedDirty === cache.dirty) cache.dirty = false;
			return dump;
		})
		.finally(() => {
			if (cache.pending === pending) cache.pending = undefined;
		});
	cache.pending = pending;
	return pending;
}

async function cachedDump(hub: AgendaHubConfig, run: typeof runBoardIo, now: () => number): Promise<HubDump> {
	const cache = dumpCache(hub);
	const age = now() - cache.at;
	if (cache.dump && !cache.dirty && age < DUMP_FRESH_MS) return cache.dump;
	if (cache.dump && !cache.dirty && age < DUMP_STALE_MS) {
		void refreshDump(hub, run, now).catch(() => {});
		return cache.dump;
	}
	try {
		return await refreshDump(hub, run, now);
	} catch (error) {
		if (cache.dump && age < DUMP_STALE_MS) return cache.dump;
		throw error;
	}
}

/** A write went through: the next read of this hub's agenda must not come from before it. */
function invalidateDump(hub: AgendaHubConfig): void {
	dumpCache(hub).dirty = true;
}

/** Today's items from tasks-hub (the `GET /api/agenda/today` body), also used by the librarian's return brief. */
export async function readAgendaToday(options: AgendaRouteOptions, days = 0): Promise<AgendaToday> {
	if (!options.hub) return { items: [], available: false, reason: "tasks-hub is not configured" };
	const run = options.runBoardIo ?? runBoardIo;
	const now = options.now ?? Date.now;
	try {
		const dump = await cachedDump(options.hub, run, now);
		const timeZone = options.hub.env.HUB_TZ ?? DEFAULT_TIME_ZONE;
		return { items: mapToday(dump, now(), timeZone, days), available: true };
	} catch (error) {
		return {
			items: [],
			available: false,
			reason: error instanceof SyntaxError ? "tasks-hub returned invalid data" : "tasks-hub is unavailable",
		};
	}
}

export function createAgendaRoutes(
	ports: AgendaPorts,
	_stateDir: string,
	options: AgendaRouteOptions = {},
): (req: Request, url: URL) => Promise<Response | undefined> {
	const run = options.runBoardIo ?? runBoardIo;

	return async (req, url) => {
		if (url.pathname === TODAY_ROUTE) {
			if (req.method !== "GET") return methodNotAllowed(req, "GET");
			// `?days=N` (0-31) also lists tasks due in the next N days.
			const daysParam = url.searchParams.get("days");
			if (daysParam !== null && !/^\d{1,2}$/.test(daysParam)) return errorResponse(400, "bad-request", "days must be an integer from 0 to 31");
			const days = daysParam === null ? 0 : Number(daysParam);
			if (days > 31) return errorResponse(400, "bad-request", "days must be an integer from 0 to 31");
			return json(200, await readAgendaToday(options, days));
		}

		if (url.pathname === `${TODOS_ROUTE}/complete`) {
			if (req.method !== "POST") return methodNotAllowed(req, "POST");
			const body = await readBody(req);
			if (!body || typeof body.sessionId !== "string" || body.sessionId.length === 0) {
				return errorResponse(400, "bad-request", "sessionId must be a non-empty string");
			}
			if (body.uid !== undefined && (typeof body.uid !== "string" || body.uid.length === 0 || body.uid.length > 512)) {
				return errorResponse(400, "bad-request", "uid must be a non-empty string");
			}
			if (!options.hub) return errorResponse(503, "internal", "tasks-hub is not configured");
			const claim = options.claimCompletion?.(body.sessionId);
			if (typeof claim === "string") return errorResponse(409, "conflict", claim);
			// The slot goes back only on a definite "not done"; an unknown outcome (the write may have landed) keeps it.
			let written: { uid: string; title: string } | undefined;
			try {
				const dump = parseHubDump(await run(options.hub, BOARD_DUMP_ARGS));
				let task: (typeof dump.items)[number];
				if (typeof body.uid === "string") {
					// A task named by the agent (from agenda_today), linked to this session or not.
					const named = dump.items.find(item => item.id === body.uid);
					if (!named || named.completed === true) return errorResponse(404, "not-found", "no open agenda task has that uid");
					task = named;
				} else {
					const link = `${OMP_CONSOLE_SESSION_URL_PREFIX}${encodeURIComponent(body.sessionId)}`;
					const matches = dump.items.filter(item => item.url === link && item.completed !== true);
					if (matches.length === 0) {
						return errorResponse(404, "not-found", "no open agenda task is linked to this session; list the agenda and pass the task's uid");
					}
					if (matches.length > 1) {
						return errorResponse(409, "conflict", "several open agenda tasks are linked to this session; pass the task's uid");
					}
					task = matches[0]!;
				}
				const expect = taskExpectation(task);
				if (!expect) return errorResponse(502, "internal", "tasks-hub omitted task priority");
				// The ask may have ended while the dump ran (a slow hub): then nothing is written.
				if (claim && !claim.active()) return errorResponse(409, "conflict", "the agenda ask is over; ask again to mark a task done");
				written = { uid: task.id, title: task.title };
				claim?.writing(written);
				const output = await run(options.hub, [
					...BOARD_WRITE_ARGS,
					JSON.stringify({ id: task.id, field: "complete", value: true, expect, apply: true }),
				]);
				invalidateDump(options.hub);
				const result = readWriteResult(output);
				if (!result) {
					claim?.uncertain({ uid: task.id, title: task.title });
					return errorResponse(502, "internal", "tasks-hub returned invalid update data");
				}
				if (result.ok !== true || result.applied !== true) {
					if (result.ok === false) claim?.release();
					else claim?.uncertain({ uid: task.id, title: task.title });
					return writeFailure(result.error);
				}
				claim?.complete({ uid: task.id, title: task.title });
				return json(200, { uid: task.id, sessionId: body.sessionId, completed: true, title: task.title });
			} catch {
				if (written) claim?.uncertain(written);
				return errorResponse(503, "internal", "tasks-hub is unavailable");
			} finally {
				if (!written) claim?.release();
			}
		}

		const linkMatch = /^\/api\/agenda\/todos\/([^/]+)\/link$/.exec(url.pathname);
		if (linkMatch) {
			if (req.method !== "POST") return methodNotAllowed(req, "POST");
			const body = await readBody(req);
			if (!body || typeof body.sessionId !== "string" || body.sessionId.length === 0) {
				return errorResponse(400, "bad-request", "sessionId must be a non-empty string");
			}
			let uid: string;
			try {
				uid = decodeURIComponent(linkMatch[1]!);
			} catch {
				return errorResponse(400, "bad-request", "task uid is invalid");
			}
			if (uid.length === 0) return errorResponse(400, "bad-request", "task uid is invalid");
			if (!options.hub) return errorResponse(503, "internal", "tasks-hub is not configured");
			try {
				const dump = parseHubDump(await run(options.hub, BOARD_DUMP_ARGS));
				const task = dump.items.find(item => item.id === uid);
				if (!task || task.completed === true) return errorResponse(404, "not-found", "open agenda task not found");
				const link = `${OMP_CONSOLE_SESSION_URL_PREFIX}${encodeURIComponent(body.sessionId)}`;
				if (task.url === link) return json(200, linkedAgendaItem(task, body.sessionId));
				if (task.url !== undefined && task.url !== null) {
					return errorResponse(409, "conflict", "agenda task already has a URL");
				}
				const expect = taskExpectation(task);
				if (!expect) return errorResponse(502, "internal", "tasks-hub omitted task priority");
				const output = await run(options.hub, [
					...BOARD_WRITE_ARGS,
					JSON.stringify({ id: task.id, field: "url", value: link, expect, apply: true }),
				]);
				invalidateDump(options.hub);
				const result = readWriteResult(output);
				if (!result) return errorResponse(502, "internal", "tasks-hub returned invalid update data");
				if (result.ok !== true || result.applied !== true) return writeFailure(result.error);
				return json(200, linkedAgendaItem(task, body.sessionId));
			} catch {
				return errorResponse(503, "internal", "tasks-hub is unavailable");
			}
		}

		if (url.pathname === TODOS_ROUTE) {
			if (req.method !== "POST") return methodNotAllowed(req, "POST");
			const body = await readBody(req);
			if (!body || typeof body.title !== "string" || body.title.trim().length === 0) {
				return errorResponse(400, "bad-request", "title must be a non-empty string");
			}
			if (body.list !== undefined && typeof body.list !== "string") {
				return errorResponse(400, "bad-request", "list must be a string");
			}
			if (body.due !== undefined && (typeof body.due !== "number" || !Number.isFinite(body.due))) {
				return errorResponse(400, "bad-request", "due must be an epoch-millisecond timestamp");
			}
			if (body.sessionId !== undefined && (typeof body.sessionId !== "string" || body.sessionId.length === 0)) {
				return errorResponse(400, "bad-request", "sessionId must be a non-empty string");
			}
			if (body.notes !== undefined && typeof body.notes !== "string") {
				return errorResponse(400, "bad-request", "notes must be a string");
			}
			if (!options.hub) return errorResponse(503, "internal", "tasks-hub is not configured");

			const timeZone = options.hub.env.HUB_TZ ?? DEFAULT_TIME_ZONE;
			let due: { date: string; time: string } | null;
			try {
				due = hubDue(body.due as number | undefined, timeZone);
			} catch {
				return errorResponse(400, "bad-request", "due is not a valid timestamp or tasks-hub timezone");
			}
			const sessionId = body.sessionId as string | undefined;
			const link = sessionId === undefined ? undefined : `${OMP_CONSOLE_SESSION_URL_PREFIX}${encodeURIComponent(sessionId)}`;
			let list = body.list as string | undefined;
			try {
				if (list === undefined) {
					const dump = parseHubDump(await run(options.hub, BOARD_DUMP_ARGS));
					list = defaultList(dump);
				}
				if (!list) return errorResponse(503, "internal", "tasks-hub has no task lists");
				const createRequest = {
					title: body.title,
					list,
					due,
					priority: 0,
					notes: (body.notes as string | undefined) ?? "",
					...(link === undefined ? {} : { url: link }),
					apply: true,
				};
				const output = await run(options.hub, [...BOARD_CREATE_ARGS, JSON.stringify(createRequest)]);
				invalidateDump(options.hub);
				let result: unknown;
				try {
					result = JSON.parse(output);
				} catch {
					return errorResponse(502, "internal", "tasks-hub returned invalid create data");
				}
				if (!isRecord(result)) return errorResponse(502, "internal", "tasks-hub returned invalid create data");
				if (result.ok !== true) {
					const message = typeof result.error === "string" ? result.error : "tasks-hub could not create the todo";
					return errorResponse(message === "save failed" ? 502 : 400, message === "save failed" ? "internal" : "bad-request", message);
				}
				if (typeof result.id !== "string" || result.id.length === 0) {
					return errorResponse(502, "internal", "tasks-hub returned invalid create data");
				}
				const created: AgendaItem = {
					uid: result.id,
					title: body.title,
					list,
					completed: false,
					...(body.due === undefined ? {} : { due: body.due as number }),
					...(body.notes === undefined ? {} : { notes: body.notes as string }),
					...(link === undefined ? {} : { url: link, sessionId }),
				};
				return json(201, created);
			} catch {
				return errorResponse(503, "internal", "tasks-hub is unavailable");
			}
		}

		if (url.pathname === ASK_ROUTE) {
			if (req.method !== "POST") return methodNotAllowed(req, "POST");
			const body = await readBody(req);
			if (!body || typeof body.text !== "string" || body.text.trim().length === 0) {
				return errorResponse(400, "bad-request", "text must be a non-empty string");
			}
			try {
				const result: AgendaAskResponse = await ports.askHidden(body.text.trim(), askSystemAddendum.trim());
				return json(200, result);
			} catch (error) {
				// omp console's own messages ("busy", "did not answer in time") reach the board; anything else stays generic.
				return errorResponse(500, "internal", error instanceof AgendaAskError ? error.message : "agenda ask failed");
			}
		}
		return undefined;
	};
}
