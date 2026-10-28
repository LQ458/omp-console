import type { OvernightPhase, OvernightState, OvernightTemplate, PreflightCheck, StartOvernightRequest } from "@omp-console/protocol";

export const DEFAULT_OVERNIGHT_TEMPLATE: OvernightTemplate = {
	prompt: `Overnight run. The user is asleep and cannot answer until morning.
- Do not ask questions. When a decision is needed, pick the conservative, reversible option, note it under "Decisions" in your final report, and continue.
- Do not stop until the task is finished end to end: implemented, checked, tested, verified by actually running it, and reviewed. If one item is blocked (missing access, permission, credential, or a decision only the user can make), record the exact blocker and continue with every other item.
- Never wait for an interactive prompt: no sudo, no password or passphrase prompts, no GUI permission dialogs. If a command asks for one, stop that command, record it as a blocker and move on.
- Keep the Mac quiet: run heavy commands with nice, at most 4 test files in parallel, one build and one browser at a time.
- Leave usage for the morning: after the deadline, start no new work; write the report.
- When everything is truly finished, write a morning report (Done, Verified, Decisions, Blockers, Next) and end your final message with the line OVERNIGHT-COMPLETE.`,
	policy: {
		deadlineLocalTime: "09:30",
		askTimeoutSec: 60,
		quiet: "quiet",
		maxIdleContinuations: 3,
		keepAwake: true,
	},
};

interface LocalParts {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
}

function localParts(date: Date, timeZone: string): LocalParts {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	}).formatToParts(date);
	const value = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find(part => part.type === type)?.value);
	return {
		year: value("year"),
		month: value("month"),
		day: value("day"),
		hour: value("hour"),
		minute: value("minute"),
		second: value("second"),
	};
}

function epochsForLocalTime(parts: LocalParts, timeZone: string): number[] {
	const desired = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
	const offsets = new Set<number>();
	for (let delta = -36; delta <= 36; delta += 6) {
		const probe = desired + delta * 60 * 60 * 1_000;
		const actual = localParts(new Date(probe), timeZone);
		offsets.add(Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second) - probe);
	}
	const exact: number[] = [];
	let nextWallTime: { epoch: number; difference: number } | null = null;
	for (const offset of offsets) {
		const candidate = desired - offset;
		const actual = localParts(new Date(candidate), timeZone);
		const actualWallTime = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
		if (actualWallTime === desired) exact.push(candidate);
		else if (actualWallTime > desired && (nextWallTime === null || actualWallTime - desired < nextWallTime.difference)) {
			nextWallTime = { epoch: candidate, difference: actualWallTime - desired };
		}
	}
	if (exact.length > 0) return exact.sort((left, right) => left - right);
	if (nextWallTime !== null) return [nextWallTime.epoch];
	throw new RangeError("could not resolve local deadline in timezone");
}

function localIsoWithOffset(epochMs: number, timeZone: string): string {
	const parts = localParts(new Date(epochMs), timeZone);
	const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
	const offsetMinutes = Math.round((localAsUtc - epochMs) / 60_000);
	const sign = offsetMinutes < 0 ? "-" : "+";
	const absoluteOffset = Math.abs(offsetMinutes);
	const offsetHour = String(Math.floor(absoluteOffset / 60)).padStart(2, "0");
	const offsetMinute = String(absoluteOffset % 60).padStart(2, "0");
	return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}T${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}:${String(parts.second).padStart(2, "0")}${sign}${offsetHour}:${offsetMinute}`;
}

/** Returns the next occurrence of a local wall-clock time, preserving the timezone offset across DST. */
export function nextLocalDeadline(
	localTime: string,
	now: Date = new Date(),
	timeZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
): string {
	const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(localTime);
	if (!match) throw new RangeError("deadline time must use HH:mm");
	const [hour, minute] = [Number(match[1]), Number(match[2])];
	const today = localParts(now, timeZone);
	const target: LocalParts = { ...today, hour, minute, second: 0 };
	const todayCandidates = epochsForLocalTime(target, timeZone);
	let deadline = todayCandidates.find(candidate => candidate > now.getTime());
	if (deadline === undefined) {
		const nextDay = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
		const nextTarget: LocalParts = {
			year: nextDay.getUTCFullYear(),
			month: nextDay.getUTCMonth() + 1,
			day: nextDay.getUTCDate(),
			hour,
			minute,
			second: 0,
		};
		deadline = epochsForLocalTime(nextTarget, timeZone).find(candidate => candidate > now.getTime());
	}
	if (deadline === undefined) throw new RangeError("could not resolve next local deadline");
	return localIsoWithOffset(deadline, timeZone);
}

export function validateOvernightTemplate(template: OvernightTemplate): string[] {
	const errors: string[] = [];
	if (template.prompt.trim() === "") errors.push("Prompt cannot be empty.");
	if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(template.policy.deadlineLocalTime)) errors.push("Deadline must use HH:mm.");
	const askTimeout = template.policy.askTimeoutSec;
	if (!Number.isSafeInteger(askTimeout) || askTimeout < 1 || askTimeout > 86_400) {
		errors.push("Ask timeout must be a whole number of seconds between 1 and 86400.");
	}
	const idleCap = template.policy.maxIdleContinuations;
	if (!Number.isSafeInteger(idleCap) || idleCap < 1 || idleCap > 100) {
		errors.push("Idle continuation cap must be a whole number between 1 and 100.");
	}
	if (!["normal", "quiet", "silent"].includes(template.policy.quiet)) errors.push("Choose a valid quiet level.");
	if (typeof template.policy.keepAwake !== "boolean") errors.push("Keep awake must be on or off.");
	return errors;
}

export function buildOvernightRequest(
	task: string,
	template: OvernightTemplate,
	policy: Partial<Omit<OvernightTemplate["policy"], "deadlineLocalTime">> = {},
	now: Date = new Date(),
	timeZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
): StartOvernightRequest {
	return {
		task: task.trim(),
		prompt: template.prompt,
		policy: {
			deadline: nextLocalDeadline(template.policy.deadlineLocalTime, now, timeZone),
			askTimeoutSec: policy.askTimeoutSec ?? template.policy.askTimeoutSec,
			quiet: policy.quiet ?? template.policy.quiet,
			maxIdleContinuations: policy.maxIdleContinuations ?? template.policy.maxIdleContinuations,
			keepAwake: policy.keepAwake ?? template.policy.keepAwake,
		},
	};
}

export function canStartOvernight(checks: readonly PreflightCheck[]): boolean {
	return checks.every(check => check.status !== "fail");
}

function localTime(epochMs: number): string {
	return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(epochMs));
}

export function overnightPhaseLabel(
	phase: OvernightPhase,
	state?: Pick<OvernightState, "nextActionAt">,
	now: number = Date.now(),
): string {
	switch (phase) {
		case "running": return "Running";
		case "continuing": return "Continuing";
		case "waiting-retry": {
			if (state?.nextActionAt === undefined) return "Retrying";
			const minutes = Math.ceil(Math.max(0, state.nextActionAt - now) / 60_000);
			return minutes <= 0 ? "Retrying now" : `Retrying in ${minutes} min`;
		}
		case "waiting-usage": return state?.nextActionAt === undefined ? "Waiting for usage reset" : `Waiting for usage reset until ${localTime(state.nextActionAt)}`;
		case "recovering": return "Recovering";
		case "wrapping-up": return "Wrapping up";
		case "complete": return "Complete";
		case "deadline": return "Deadline reached";
		case "blocked": return "Blocked";
		case "stopped": return "Stopped";
	}
}
