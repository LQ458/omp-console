import { describe, expect, it } from "bun:test";
import type { RoomLinkResponse } from "@omp-console/protocol";
import {
	answerRoomLink,
	DEFAULT_SOURCES,
	isQuickAskShortcut,
	loadSources,
	questionBlocker,
	SOURCES_KEY,
	saveSources,
	toggleSource,
} from "../src/components/workspaces/quick-ask";
import { DeckApiError } from "../src/lib/api";
import type { KeyValueStorage } from "../src/lib/storage";

function memoryStorage(initial: Record<string, string> = {}): KeyValueStorage & { data: Map<string, string> } {
	const data = new Map(Object.entries(initial));
	return {
		data,
		getItem: key => data.get(key) ?? null,
		setItem: (key, value) => void data.set(key, value),
		removeItem: key => void data.delete(key),
	};
}

describe("quick-ask sources", () => {
	it("starts with no sources and restores only configured choices in canonical order", () => {
		expect(DEFAULT_SOURCES).toEqual([]);
		expect(loadSources(memoryStorage())).toEqual([]);
		const storage = memoryStorage();
		saveSources(storage, ["history", "web", "siyuan"]);
		expect(loadSources(storage, ["history", "siyuan"])).toEqual(["siyuan", "history"]);
	});

	it("fails closed for corrupted or unavailable source preferences", () => {
		expect(loadSources(memoryStorage({ [SOURCES_KEY]: "{not json" }), ["siyuan"])).toEqual([]);
		expect(loadSources(memoryStorage({ [SOURCES_KEY]: '{"a":1}' }), ["siyuan"])).toEqual([]);
		expect(loadSources(memoryStorage({ [SOURCES_KEY]: '["siyuan","carrier-pigeon"]' }), ["repo"])).toEqual([]);
		expect(loadSources(undefined, ["siyuan"])).toEqual([]);
	});

	it("toggles one source without disturbing the order of the others", () => {
		expect(toggleSource(["siyuan", "history"], "repo")).toEqual(["siyuan", "repo", "history"]);
		expect(toggleSource(["siyuan", "repo", "history"], "repo")).toEqual(["siyuan", "history"]);
	});

	it("will not send an empty question or a question with no source", () => {
		expect(questionBlocker("  ", ["siyuan"])).toBe("Type a question.");
		expect(questionBlocker("when?", [])).toBe("Pick at least one source.");
		expect(questionBlocker("when?", ["siyuan"])).toBeNull();
	});
});

describe("isQuickAskShortcut", () => {
	const key = (over: Partial<Parameters<typeof isQuickAskShortcut>[0]>) => ({ key: "j", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over });
	it("is Cmd+J or Ctrl+J and nothing with another modifier", () => {
		expect(isQuickAskShortcut(key({ metaKey: true }))).toBe(true);
		expect(isQuickAskShortcut(key({ ctrlKey: true, key: "J" }))).toBe(true);
		expect(isQuickAskShortcut(key({}))).toBe(false);
		expect(isQuickAskShortcut(key({ metaKey: true, shiftKey: true }))).toBe(false);
		expect(isQuickAskShortcut(key({ metaKey: true, altKey: true }))).toBe(false);
		expect(isQuickAskShortcut(key({ metaKey: true, key: "k" }))).toBe(false);
	});
});

describe("answerRoomLink", () => {
	const ROOM: RoomLinkResponse = { roomId: "r", link: "wss://x/#k", permission: "view" };
	const noSleep = async (): Promise<void> => {};

	it("retries while the worker is still starting and asks for a view-only answer link", async () => {
		let calls = 0;
		const permissions: string[] = [];
		const room = await answerRoomLink(
			{
				async roomLink(_sessionId, permission) {
					permissions.push(permission);
					if (++calls < 3) throw new DeckApiError("conflict", 409, "starting");
					return ROOM;
				},
			},
			"s1",
			{ sleep: noSleep },
		);
		expect(room).toBe(ROOM);
		expect(calls).toBe(3);
		expect(permissions).toEqual(["view", "view", "view"]);
	});

	it("gives up after the retry budget and never retries other errors", async () => {
		let calls = 0;
		const starting = { roomLink: async (): Promise<RoomLinkResponse> => (calls++, Promise.reject(new DeckApiError("conflict", 409, "starting"))) };
		await expect(answerRoomLink(starting, "s1", { retries: 2, sleep: noSleep })).rejects.toThrow("starting");
		expect(calls).toBe(3);
		let other = 0;
		const missing = { roomLink: async (): Promise<RoomLinkResponse> => (other++, Promise.reject(new DeckApiError("not-found", 404, "gone"))) };
		await expect(answerRoomLink(missing, "s1", { sleep: noSleep })).rejects.toThrow("gone");
		expect(other).toBe(1);
	});
});
