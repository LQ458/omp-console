import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { firstPromptTitle, publishCardTitles, rememberUserTitle, sessionDisplayTitle, useUserTitle } from "../src/lib/card-titles";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

function user(text: string, id: string): SessionEntry {
	return { type: "message", id, parentId: null, timestamp: "2026-10-24T00:00:00Z", message: { role: "user", content: text, timestamp: 0 } } as SessionEntry;
}

describe("sessionDisplayTitle", () => {
	test("the user's rename wins, then omp's title, then the session name, then the list's title, then the first prompt", () => {
		const all = { headerTitle: "omp title", sessionName: "name", cardTitle: "card", promptTitle: "prompt" };
		expect(sessionDisplayTitle({ ...all, userTitle: "my name" })).toBe("my name");
		expect(sessionDisplayTitle(all)).toBe("omp title");
		expect(sessionDisplayTitle({ ...all, headerTitle: "  " })).toBe("name");
		expect(sessionDisplayTitle({ ...all, headerTitle: null, sessionName: undefined })).toBe("card");
		expect(sessionDisplayTitle({ promptTitle: "prompt" })).toBe("prompt");
		expect(sessionDisplayTitle({})).toBe("session");
	});
});

describe("firstPromptTitle", () => {
	test("takes the first user prompt as one line and shortens a long one", () => {
		const long = `Fix   the\nfailing\ttest ${"x".repeat(200)}`;
		const title = firstPromptTitle([user(long, "a"), user("second", "b")]);
		expect(title?.startsWith("Fix the failing test x")).toBe(true);
		expect(title?.length).toBe(80);
		expect(title?.endsWith("…")).toBe(true);
	});

	test("skips empty prompts and returns nothing for a transcript without one", () => {
		expect(firstPromptTitle([user("   ", "a"), user("real one", "b")])).toBe("real one");
		expect(firstPromptTitle([])).toBeUndefined();
	});
});

describe("user titles", () => {
	const shown = (id: string): string => {
		const Probe = () => createElement("span", null, useUserTitle(id) ?? "none");
		return renderToStaticMarkup(createElement(Probe));
	};

	test("a rename survives a list loaded before it, until a card confirms it", () => {
		rememberUserTitle("vps:abc", "My title");
		expect(shown("abc")).toContain("My title");
		// The list's cards predate the rename: generated title, not user-sourced.
		publishCardTitles([{ sessionId: "vps:abc", title: "Generated", titleSource: "omp" }]);
		expect(shown("abc")).toContain("My title");
		// The list catches up: the card confirms the rename.
		publishCardTitles([{ sessionId: "vps:abc", title: "My title", titleSource: "user" }]);
		expect(shown("abc")).toContain("My title");
		// Cleared later in the list (generated again): the user title goes away.
		publishCardTitles([{ sessionId: "vps:abc", title: "Generated", titleSource: "omp" }]);
		expect(shown("abc")).toContain("none");
	});

	test("a later rename replaces an earlier one the list has not seen yet", () => {
		rememberUserTitle("xyz", "From the header");
		rememberUserTitle("xyz", "From the list");
		publishCardTitles([{ sessionId: "xyz", title: "From the list", titleSource: "user" }]);
		expect(shown("xyz")).toContain("From the list");
	});
});
