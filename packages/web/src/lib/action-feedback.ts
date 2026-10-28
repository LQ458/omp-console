import { useEffect, useState, useSyncExternalStore } from "react";

export type ActionFeedbackState = "idle" | "pending" | "success" | "failure";
export interface ActionFeedbackSnapshot {
	state: ActionFeedbackState;
	error: string | null;
}
export interface ActionFeedback {
	state: ActionFeedbackState;
	error: string | null;
	begin(): boolean;
	succeed(): void;
	fail(error: unknown): void;
	run<T>(action: () => T | Promise<T>): Promise<T | undefined>;
	reset(): void;
}

type Schedule = (callback: () => void, delayMs: number) => () => void;

const SUCCESS_VISIBLE_MS = 700;
const IDLE: ActionFeedbackSnapshot = { state: "idle", error: null };
const scheduleTimer: Schedule = (callback, delayMs) => {
	const timer = globalThis.setTimeout(callback, delayMs);
	return () => globalThis.clearTimeout(timer);
};

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "Action failed.";
}

/** One non-concurrent async action's pending/success/failure state. */
export class ActionFeedbackController {
	readonly #schedule: Schedule;
	readonly #listeners = new Set<() => void>();
	#snapshot: ActionFeedbackSnapshot = IDLE;
	#cancelTimer: (() => void) | null = null;
	#pending = false;
	#disposed = false;

	constructor(schedule: Schedule = scheduleTimer) {
		this.#schedule = schedule;
	}

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	getSnapshot = (): ActionFeedbackSnapshot => this.#snapshot;

	begin = (): boolean => {
		if (this.#pending || this.#disposed) return false;
		this.#cancelTimer?.();
		this.#cancelTimer = null;
		this.#pending = true;
		this.#set({ state: "pending", error: null });
		return true;
	};

	succeed = (): void => {
		if (!this.#pending || this.#disposed) return;
		this.#pending = false;
		this.#set({ state: "success", error: null });
		this.#cancelTimer = this.#schedule(() => {
			this.#cancelTimer = null;
			if (this.#snapshot.state === "success") this.reset();
		}, SUCCESS_VISIBLE_MS);
	};

	fail = (error: unknown): void => {
		if (!this.#pending || this.#disposed) return;
		this.#pending = false;
		this.#set({ state: "failure", error: errorMessage(error) });
	};

	run = async <T,>(action: () => T | Promise<T>): Promise<T | undefined> => {
		if (!this.begin()) return undefined;
		try {
			const result = await action();
			this.succeed();
			return result;
		} catch (error) {
			this.fail(error);
			throw error;
		}
	};

	reset = (): void => {
		this.#cancelTimer?.();
		this.#cancelTimer = null;
		this.#pending = false;
		if (!this.#disposed) this.#set(IDLE);
	};

	activate = (): void => {
		this.#disposed = false;
	};

	dispose = (): void => {
		this.#disposed = true;
		this.#pending = false;
		this.#cancelTimer?.();
		this.#cancelTimer = null;
		this.#listeners.clear();
	};

	#set(snapshot: ActionFeedbackSnapshot): void {
		if (this.#snapshot.state === snapshot.state && this.#snapshot.error === snapshot.error) return;
		this.#snapshot = snapshot;
		for (const listener of this.#listeners) listener();
	}
}

/** React binding for components that need the same action feedback lifecycle. */
export function useActionFeedback(): ActionFeedback {
	const [controller] = useState(() => new ActionFeedbackController());
	const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
	useEffect(() => {
		controller.activate();
		return controller.dispose;
	}, [controller]);
	return {
		...snapshot,
		begin: controller.begin,
		succeed: controller.succeed,
		fail: controller.fail,
		run: controller.run,
		reset: controller.reset,
	};
}
