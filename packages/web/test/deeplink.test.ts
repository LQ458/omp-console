import { describe, expect, it } from "bun:test";
import { DeckApiError } from "../src/lib/api";
import { type HashTarget, consumePairFragment, foreignRelayHost, parseDeepLink, watchSessionDeepLink } from "../src/lib/deeplink";
import type { PairFragmentTarget } from "../src/lib/deeplink";
import { type SessionClient, SessionSwitcher } from "../src/lib/switcher";

class FakeWindow implements HashTarget, PairFragmentTarget {
	location = { hash: "", pathname: "/pair", search: "?theme=dark" };
	history = {
		state: { keep: true } as unknown,
		replaceState: (_data: unknown, _unused: string, value?: string | URL | null): void => {
			if (value === undefined || value === null) return;
			const next = new URL(value.toString(), "https://omp-console.example");
			this.location.pathname = next.pathname;
			this.location.search = next.search;
			this.location.hash = next.hash;
		},
	};
	#listeners = new Set<() => void>();
	addEventListener(_type: "hashchange", listener: () => void): void {
		this.#listeners.add(listener);
	}
	removeEventListener(_type: "hashchange", listener: () => void): void {
		this.#listeners.delete(listener);
	}
	get listenerCount(): number {
		return this.#listeners.size;
	}
	navigate(hash: string): void {
		this.location.hash = hash;
		for (const listener of [...this.#listeners]) listener();
	}
}


describe("consumePairFragment", () => {
	it("returns a pair code once, removes only the hash, and preserves the page query", () => {
		const win = new FakeWindow();
		win.location.hash = "#pair=ABCD-EFGH";
		expect(consumePairFragment(win)).toBe("ABCD-EFGH");
		expect(win.location).toEqual({ hash: "", pathname: "/pair", search: "?theme=dark" });
		expect(win.history.state).toEqual({ keep: true });
		expect(consumePairFragment(win)).toBeNull();
	});
});


describe("parseDeepLink", () => {
	it("never treats a pairing fragment as a collaboration room", () => {
		expect(parseDeepLink("#pair=ABCD-EFGH")).toBeNull();
	});

	it("separates a session link from a collab room link", () => {
		expect(parseDeepLink("#session=abc-123")).toEqual({ kind: "session", sessionId: "abc-123" });
		expect(parseDeepLink("session=vps:session_1&x=1")).toEqual({ kind: "session", sessionId: "vps:session_1" });
		const room = "roomroomroom1234#c2VjcmV0";
		expect(parseDeepLink(`#${room}`)).toEqual({ kind: "room", link: room });
	});

	it("rejects session ids outside the daemon and machine-prefixed id format", () => {
		expect(parseDeepLink("#session=a%2Fb")).toBeNull();
		expect(parseDeepLink("#session=bad%3Aprefix%3Aid")).toBeNull();
		expect(parseDeepLink(`#session=${"x".repeat(128)}`)).toEqual({ kind: "session", sessionId: "x".repeat(128) });
		expect(parseDeepLink(`#session=${"x".repeat(129)}`)).toBeNull();
	});

	it("caps decoded new-session paths at 1024 characters", () => {
		const path = `/${"x".repeat(1023)}`;
		expect(parseDeepLink(`#new=${encodeURIComponent(path)}`)).toEqual({ kind: "new", cwd: path });
		expect(parseDeepLink(`#new=${encodeURIComponent(`${path}x`)}`)).toBeNull();
	});

	it("flags foreign relays but accepts the page origin and its peer bridge", () => {
		const key = "A".repeat(43);
		const roomId = "roomroomroom1234";
		expect(foreignRelayHost(`evil.example/r/${roomId}.${key}`, "https://omp-console.example")).toBe("evil.example");
		expect(foreignRelayHost(`omp-console.example/r/${roomId}.${key}`, "https://omp-console.example")).toBeNull();
		expect(foreignRelayHost(`omp-console.example/peers/vps/r/${roomId}.${key}`, "https://omp-console.example")).toBeNull();
	});

	it("rejects an empty hash and a session link without an id", () => {
		expect(parseDeepLink("")).toBeNull();
		expect(parseDeepLink("#")).toBeNull();
		expect(parseDeepLink("#session=")).toBeNull();
		expect(parseDeepLink("#session=%20")).toBeNull();
	});
});

describe("watchSessionDeepLink", () => {
	function watch(initialHash: string) {
		const win = new FakeWindow();
		win.location.hash = initialHash;
		const selected: string[] = [];
		const stop = watchSessionDeepLink(
			win,
			id => selected.push(id),
			() => {
				win.location.hash = "";
			},
		);
		return { win, selected, stop };
	}

	it("selects the session named on load and again for each later link, even the same one", () => {
		const { win, selected } = watch("#session=s1");
		expect(selected).toEqual(["s1"]);
		expect(win.location.hash).toBe(""); // cleared, so tapping the same notification again is a real change

		win.navigate("#session=s2");
		win.navigate("#session=s2");
		expect(selected).toEqual(["s1", "s2", "s2"]);
	});

	it("leaves room links and unrelated hashes alone", () => {
		const { win, selected } = watch("#roomroomroom1234#c2VjcmV0");
		win.navigate("#about");
		expect(selected).toEqual([]);
		expect(win.location.hash).toBe("#about");
	});

	it("stops reacting after it is disposed", () => {
		const { win, selected, stop } = watch("");
		stop();
		win.navigate("#session=s9");
		expect(selected).toEqual([]);
		expect(win.listenerCount).toBe(0);
	});
});

describe("deep link through the session switcher", () => {
	it("opens the named session's room even before the session list was ever loaded, and reports an unknown one", async () => {
		const connected: string[] = [];
		const switcher = new SessionSwitcher<SessionClient>({
			api: {
				listSessions: async () => ({ live: [], recent: [] }),
				health: async () => {
					throw new Error("not needed");
				},
				createSession: async () => {
					throw new Error("not needed");
				},
				roomLink: async sessionId => {
					if (sessionId !== "a") throw new DeckApiError("not-found", 404, "no such live session");
					return { roomId: "room-a", link: "link-a", permission: "full" };
				},
				stopSession: async () => {},
			},
			createClient: link => ({
				connect: () => {
					if (link !== null) connected.push(link);
				},
				close: () => {},
				reconnect: () => true,
			}),
			name: "tester",
		});
		const win = new FakeWindow();
		const pending: Promise<void>[] = [];
		const stop = watchSessionDeepLink(
			win,
			id => pending.push(switcher.select(id)),
			() => {},
		);

		win.navigate("#session=a");
		await Promise.all(pending);
		expect(connected).toEqual(["link-a"]);
		expect(switcher.getSnapshot().selectedId).toBe("a");

		win.navigate("#session=gone");
		await Promise.all(pending);
		expect(switcher.getSnapshot().selectedId).toBe("a"); // a bad link keeps the current session
		expect(switcher.getSnapshot().actionError).toContain("no such live session");
		stop();
	});
});
