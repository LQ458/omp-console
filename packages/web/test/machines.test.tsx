import { describe, expect, it } from "bun:test";
import type { DaemonHealth, ListSessionsResponse, PeersResponse, RoomLinkResponse, SessionSummary } from "@omp-console/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionSidebar } from "../src/components/switcher/SessionSidebar";
import { MachineChip } from "../src/components/machines/MachineChip";
import { DeckApi, DeckApiError } from "../src/lib/api";
import { parseDeepLink } from "../src/lib/deeplink";
import { groupSessionCards, mergeSessionCards } from "../src/lib/cards";
import {
	createMachineSwitcherApi,
	isMachineNetworkError,
	MachineDirectory,
	sessionIdForSessionKey,
	sessionKey,
	splitSessionKey,
	rewritePeerRoomLink,
	type Machine,
} from "../src/lib/machines";
import { formatCollabLink } from "../src/lib/link";

function summary(id: string, lastActivityAt: number, extra: Partial<SessionSummary> = {}): SessionSummary {
	return {
		id,
		cwd: `/work/${id}`,
		sessionFile: `/work/${id}.jsonl`,
		state: "idle",
		createdAt: 1,
		lastActivityAt,
		agentCount: 0,
		goalActive: false,
		awaitingAnswer: false,
		...extra,
	};
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

interface ApiCall {
	machine: "local" | "peer";
	method: string;
	path: string;
}

function apiFor(machine: ApiCall["machine"], calls: ApiCall[]): DeckApi {
	const base = machine === "local" ? "/api" : "/api/peers/vps";
	return new DeckApi({
		base,
		fetch: async (input, init) => {
			const url = new URL(input, "https://deck.test");
			const method = init?.method ?? "GET";
			calls.push({ machine, method, path: url.pathname });
			if (machine === "local" && url.pathname === "/api/peers") {
				const peers: PeersResponse = {
					self: { id: "mac", name: "Mac" },
					peers: [{ id: "vps", name: "VPS", reachable: true }],
				};
				return json(peers);
			}
			if (url.pathname.endsWith("/health")) {
				const health: DaemonHealth = {
					version: 1,
					startedAt: 1,
					workers: [{
						sessionId: machine === "peer" ? "peer-live" : "local-live",
						pid: 1,
						state: "streaming",
						rssBytes: 1,
						startedAt: 1,
						lastEventAt: 1,
						stalled: false,
						restarts: 0,
					}],
					guests: 1,
					stalledAfterMs: 60_000,
				};
				return json(health);
			}
			if (url.pathname.endsWith("/room")) {
				const room: RoomLinkResponse = {
					roomId: "abcdefghij",
					link: formatCollabLink("wss://peer.example", "abcdefghij", new Uint8Array(32).fill(7), new Uint8Array(16).fill(9)),
					permission: "full",
				};
				return json(room);
			}
			if (url.pathname.endsWith("/sessions") && method === "GET") {
				const response: ListSessionsResponse = machine === "peer"
					? { live: [summary("peer-live", 30)], recent: [summary("peer-old", 10)] }
					: { live: [summary("local-live", 20)], recent: [] };
				return json(response);
			}
			if (url.pathname.endsWith("/sessions") && method === "POST") {
				return json(summary(machine === "peer" ? "peer-created" : "local-created", 40), 201);
			}
			if (method === "DELETE") return new Response(null, { status: 204 });
			return json({ error: "not found", code: "not-found" }, 404);
		},
	});
}

function renderSidebar(overrides: Partial<React.ComponentProps<typeof SessionSidebar>> = {}): string {
	const localApi = new DeckApi();
	const machines: Machine[] = [
		{ id: "mac", name: "Mac", api: localApi, local: true, reachable: true },
		{ id: "vps", name: "VPS", api: new DeckApi(), local: false, reachable: false },
	];
	return renderToStaticMarkup(
		<SessionSidebar
			sessions={{ live: [], recent: [] }}
			health={null}
			listError={null}
			authFailed={false}
			selectedId={null}
			busy={false}
			actionError={null}
			machines={machines}
			onSelect={() => {}}
			onResume={() => {}}
			onFork={() => {}}
			onStop={() => {}}
			onCreate={() => {}}
			{...overrides}
		/>,
	);
}

describe("machine session identity and relay links", () => {
	it("keeps local ids bare and round-trips peer ids through the machine prefix", () => {
		const local = { id: "mac", local: true };
		const peer = { id: "vps", local: false };
		expect(sessionKey(local, "session-1")).toBe("session-1");
		const key = sessionKey(peer, "session-1");
		expect(key).toBe("vps:session-1");
		expect(splitSessionKey(key)).toEqual({ machineId: "vps", sessionId: "session-1", link: false });
		expect(sessionIdForSessionKey(key)).toBe("session-1");
		expect(parseDeepLink("#session=vps:session-1")).toEqual({ kind: "session", sessionId: "vps:session-1" });
		expect(splitSessionKey("link:wss://relay.example/r/room.key")).toEqual({
			machineId: null,
			sessionId: "link:wss://relay.example/r/room.key",
			link: true,
		});
	});

	it("rewrites peer relay links to this origin without losing read or write secrets", () => {
		const readOnly = formatCollabLink("wss://peer.example", "abcdefghij", new Uint8Array(32).fill(7));
		const full = formatCollabLink("wss://peer.example", "abcdefghij", new Uint8Array(32).fill(7), new Uint8Array(16).fill(9));
		const viewLink = rewritePeerRoomLink(readOnly, "vps", "https://omp-console.example:8443");
		const fullLink = rewritePeerRoomLink(full, "vps", "https://omp-console.example:8443");
		const localLink = rewritePeerRoomLink(readOnly, "vps", "http://127.0.0.1:8123");
		expect(localLink).toBe(`ws://127.0.0.1:8123/peers/vps/r/abcdefghij.${readOnly.slice(readOnly.lastIndexOf(".") + 1)}`);
		expect(viewLink).toBe(`wss://omp-console.example:8443/peers/vps/r/abcdefghij.${readOnly.slice(readOnly.lastIndexOf(".") + 1)}`);
		expect(fullLink).toBe(`wss://omp-console.example:8443/peers/vps/r/abcdefghij.${full.slice(full.lastIndexOf(".") + 1)}`);
	});
});

describe("merged machine session data", () => {
	it("merges local and peer sessions into independently keyed status groups", () => {
		const live = [summary("local-live", 20), summary("vps:peer-live", 30)];
		const merged = mergeSessionCards([], live, []);
		const groups = groupSessionCards(merged, [], false);
		const groupedIds = groups.flatMap(group => group.cards.map(item => item.card.sessionId));
		expect(new Set(groupedIds)).toEqual(new Set(["local-live", "vps:peer-live"]));
	});

	it("renders machine chip labels and keeps an unreachable peer quiet", () => {
		const chipHtml = renderToStaticMarkup(<MachineChip name="VPS" />);
		const unavailableHtml = renderSidebar();
		const recoveredHtml = renderSidebar({
			machines: [
				{ id: "mac", name: "Mac", api: new DeckApi(), local: true, reachable: true },
				{ id: "vps", name: "VPS", api: new DeckApi(), local: false, reachable: true },
			],
		});
		expect(chipHtml).toContain("dk-machine-chip");
		expect(chipHtml).toContain("VPS");
		expect(unavailableHtml).toContain("VPS unreachable");
		expect(unavailableHtml).not.toContain("Session cards are unavailable");
		expect(unavailableHtml).not.toContain("role=\"alert\"");
		expect(recoveredHtml).not.toContain("VPS unreachable");
	});
});

describe("peer API routing", () => {
	it("merges sessions and health and routes room links, create, and stop through the peer API", async () => {
		const calls: ApiCall[] = [];
		const localApi = apiFor("local", calls);
		const directory = new MachineDirectory(localApi, () => apiFor("peer", calls));
		await directory.refresh();
		const api = createMachineSwitcherApi(directory, () => "https://deck.test");

		const sessions = await api.listSessions();
		const health = await api.health();
		const room = await api.roomLink("vps:peer-live");
		const created = await api.createSession({ cwd: "/remote/work" }, "vps");
		await api.stopSession(created.id);

		expect(sessions.live.map(session => session.id)).toEqual(["vps:peer-live", "local-live"]);
		expect(sessions.recent.map(session => session.id)).toEqual(["vps:peer-old"]);
		expect(health.workers.map(worker => worker.sessionId)).toEqual(["local-live", "vps:peer-live"]);
		expect(created.id).toBe("vps:peer-created");
		const proxyUrl = new URL(room.link);
		expect(proxyUrl.pathname.startsWith("/peers/vps/r/abcdefghij.")).toBe(true);
		expect(calls).toContainEqual({ machine: "peer", method: "POST", path: "/api/peers/vps/sessions/peer-live/room" });
		expect(calls).toContainEqual({ machine: "peer", method: "POST", path: "/api/peers/vps/sessions" });
		expect(calls).toContainEqual({ machine: "peer", method: "DELETE", path: "/api/peers/vps/sessions/peer-created" });
		expect(calls.some(call => call.machine === "local" && call.path.includes("/sessions/peer-"))).toBe(false);
		directory.dispose();
	});
});
describe("peer outage recovery", () => {
	it("keeps the last peer sessions during an outage and replaces them after recovery", async () => {
		let proxyDown = false;
		let advertisedReachable = true;
		let peerSessionId = "peer-live";
		const localApi = new DeckApi({
			fetch: async input => {
				const pathname = new URL(input, "https://deck.test").pathname;
				if (pathname === "/api/peers") {
					return json({
						self: { id: "mac", name: "Mac" },
						peers: [{ id: "vps", name: "VPS", reachable: advertisedReachable }],
					} satisfies PeersResponse);
				}
				if (pathname === "/api/sessions") {
					return json({ live: [summary("local-live", 20)], recent: [] } satisfies ListSessionsResponse);
				}
				throw new Error(`unexpected local path ${pathname}`);
			},
		});
		const peerApi = new DeckApi({
			base: "/api/peers/vps",
			fetch: async input => {
				const pathname = new URL(input, "https://deck.test").pathname;
				if (pathname.endsWith("/sessions") && proxyDown) {
					return json({ error: 'peer "VPS" is unreachable', code: "internal" }, 502);
				}
				if (pathname.endsWith("/sessions")) {
					return json({
						live: [summary(peerSessionId, 30)],
						recent: [summary(`${peerSessionId}-old`, 10)],
					} satisfies ListSessionsResponse);
				}
				throw new Error(`unexpected peer path ${pathname}`);
			},
		});
		const directory = new MachineDirectory(localApi, () => peerApi);
		await directory.refresh();
		let changes = 0;
		const unsubscribe = directory.subscribe(() => changes++);
		const switcherApi = createMachineSwitcherApi(directory);

		const first = await switcherApi.listSessions();
		expect(first.live.map(session => session.id)).toEqual(["vps:peer-live", "local-live"]);
		expect(first.recent.map(session => session.id)).toEqual(["vps:peer-live-old"]);

		proxyDown = true;
		const outage = await switcherApi.listSessions();
		expect(outage.live.map(session => session.id)).toEqual(["vps:peer-live", "local-live"]);
		expect(outage.recent.map(session => session.id)).toEqual(["vps:peer-live-old"]);
		expect(directory.machine("vps")?.reachable).toBe(false);
		expect(directory.canAttempt("vps")).toBe(false);
		expect(changes).toBe(1);

		proxyDown = false;
		peerSessionId = "peer-returned";
		await directory.refresh();
		expect(directory.machine("vps")?.reachable).toBe(true);
		expect(directory.canAttempt("vps")).toBe(true);
		expect(changes).toBe(2);
		const recovered = await switcherApi.listSessions();
		expect(recovered.live.map(session => session.id)).toEqual(["vps:peer-returned", "local-live"]);
		expect(recovered.recent.map(session => session.id)).toEqual(["vps:peer-returned-old"]);
		await directory.refresh();
		expect(changes).toBe(2);

		unsubscribe();
		directory.dispose();
	});

	it("does not mark a peer unreachable when the local daemon cannot answer", async () => {
		let localOffline = false;
		const peerCalls: string[] = [];
		const localApi = new DeckApi({
			fetch: async input => {
				const pathname = new URL(input, "https://deck.test").pathname;
				if (pathname === "/api/peers") {
					return json({
						self: { id: "mac", name: "Mac" },
						peers: [{ id: "vps", name: "VPS", reachable: true }],
					} satisfies PeersResponse);
				}
				if (pathname === "/api/sessions") {
					if (localOffline) throw new Error("local daemon stopped");
					return json({ live: [summary("local-live", 20)], recent: [] } satisfies ListSessionsResponse);
				}
				throw new Error(`unexpected local path ${pathname}`);
			},
		});
		const peerApi = new DeckApi({
			base: "/api/peers/vps",
			fetch: async input => {
				peerCalls.push(new URL(input, "https://deck.test").pathname);
				return json({ live: [summary("peer-live", 30)], recent: [] } satisfies ListSessionsResponse);
			},
		});
		const directory = new MachineDirectory(localApi, () => peerApi);
		await directory.refresh();
		const switcherApi = createMachineSwitcherApi(directory);
		localOffline = true;

		let failure: unknown;
		try {
			await switcherApi.listSessions();
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(DeckApiError);
		expect(failure instanceof DeckApiError ? failure.kind : null).toBe("network");
		expect(peerCalls).toEqual([]);
		let healthFailure: unknown;
		try {
			await switcherApi.health();
		} catch (error) {
			healthFailure = error;
		}
		expect(healthFailure).toBeInstanceOf(DeckApiError);
		expect(peerCalls).toEqual([]);
		expect(directory.machine("vps")?.reachable).toBe(true);
		expect(directory.canAttempt("vps")).toBe(true);
		expect(isMachineNetworkError(new DeckApiError("network", 0, "daemon unreachable"))).toBe(false);
		expect(isMachineNetworkError(new DeckApiError("server", 502, 'peer "VPS" is unreachable'))).toBe(true);
		directory.dispose();
	});
});
