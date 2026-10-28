import { describe, expect, test } from "bun:test";
import type { SessionSummary } from "@omp-console/protocol";
import { forgetLastSession, pickRestorableSession, readLastSession, rememberLastSession } from "../src/lib/last-session";

function live(...ids: string[]): SessionSummary[] {
	return ids.map(id => ({
		id,
		cwd: "/tmp",
		state: "idle",
		createdAt: 0,
		lastActivityAt: 0,
		agentCount: 0,
		goalActive: false,
		awaitingAnswer: false,
	}));
}

describe("pickRestorableSession", () => {
	test("reopens the remembered session while it is still live", () => {
		expect(pickRestorableSession("b", live("a", "b"), "", null)).toBe("b");
	});

	test("does nothing when the remembered session is gone or nothing was remembered", () => {
		expect(pickRestorableSession("gone", live("a"), "", null)).toBeNull();
		expect(pickRestorableSession(null, live("a"), "", null)).toBeNull();
	});

	test("a deep link or an existing selection wins over the remembered session", () => {
		expect(pickRestorableSession("b", live("b"), "#session=a", null)).toBeNull();
		expect(pickRestorableSession("b", live("b"), "#ws://127.0.0.1/r/room.key", null)).toBeNull();
		expect(pickRestorableSession("b", live("b"), "", "a")).toBeNull();
		expect(pickRestorableSession("b", live("b"), "#", null)).toBe("b");
	});
});

describe("last session storage", () => {
	test("round-trips, forgets, and survives a storage that throws", () => {
		const data = new Map<string, string>();
		const storage = {
			setItem: (key: string, value: string) => void data.set(key, value),
			getItem: (key: string) => data.get(key) ?? null,
			removeItem: (key: string) => void data.delete(key),
		};
		rememberLastSession(storage, "abc");
		expect(readLastSession(storage)).toBe("abc");
		forgetLastSession(storage);
		expect(readLastSession(storage)).toBeNull();

		const blocked = {
			setItem: () => {
				throw new Error("blocked");
			},
			getItem: () => {
				throw new Error("blocked");
			},
			removeItem: () => {
				throw new Error("blocked");
			},
		};
		expect(() => rememberLastSession(blocked, "x")).not.toThrow();
		expect(readLastSession(blocked)).toBeNull();
		expect(() => forgetLastSession(blocked)).not.toThrow();
	});
});
