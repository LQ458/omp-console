import type {
	DaemonHealth,
	ListSessionsResponse,
	PeersResponse,
	RoomLinkResponse,
	RoomPermission,
	SessionSummary,
} from "@omp-console/protocol";
import { useCallback, useSyncExternalStore } from "react";
import { DeckApi, DeckApiError } from "./api";
import { offlineTranscriptCache } from "./offline-cache/cache";
import type { OfflineSessionStatus } from "./offline-cache/types";
import { encodeBase64Url, parseCollabLink } from "./link";
import type { SessionSwitcherApi } from "./switcher";

export const LOCAL_MACHINE_KEY = "local";

export interface Machine {
	id: string;
	name: string;
	api: DeckApi;
	local: boolean;
	reachable: boolean;
	reason?: string;
}

export interface MachinesSnapshot {
	machines: readonly Machine[];
}

export interface SessionKeyParts {
	machineId: string | null;
	sessionId: string;
	link: boolean;
}

export function sessionKey(machine: Pick<Machine, "id" | "local">, sessionId: string): string {
	return machine.local ? sessionId : `${machine.id}:${sessionId}`;
}

export function splitSessionKey(key: string): SessionKeyParts {
	if (key.startsWith("link:")) return { machineId: null, sessionId: key, link: true };
	const separator = key.indexOf(":");
	if (separator <= 0) return { machineId: null, sessionId: key, link: false };
	return { machineId: key.slice(0, separator), sessionId: key.slice(separator + 1), link: false };
}

export function machineIdForSessionKey(key: string): string | null {
	return splitSessionKey(key).machineId;
}

export function sessionIdForSessionKey(key: string): string {
	return splitSessionKey(key).sessionId;
}

export function machineForSessionKey(key: string, machines: readonly Machine[]): Machine | undefined {
	const parts = splitSessionKey(key);
	return parts.machineId === null ? machines.find(machine => machine.local) : machines.find(machine => machine.id === parts.machineId);
}

export function rewritePeerRoomLink(link: string, peerId: string, origin: string): string {
	const parsed = parseCollabLink(link);
	if ("error" in parsed) throw new Error(parsed.error);
	const page = new URL(origin);
	const protocol = page.protocol === "https:" ? "wss:" : page.protocol === "http:" ? "ws:" : null;
	if (protocol === null) throw new Error(`Unsupported page URL scheme: ${page.protocol}`);
	const secret =
		parsed.writeToken === undefined
			? parsed.key
			: new Uint8Array(parsed.key.byteLength + parsed.writeToken.byteLength);
	if (parsed.writeToken !== undefined) {
		secret.set(parsed.key);
		secret.set(parsed.writeToken, parsed.key.byteLength);
	}
	return `${protocol}//${page.host}/peers/${encodeURIComponent(peerId)}/r/${parsed.roomId}.${encodeBase64Url(secret)}`;
}

export type PeerApiFactory = (peerId: string) => DeckApi;

export function isMachineNetworkError(error: unknown): boolean {
	return error instanceof DeckApiError && error.status === 502 && /^peer ".+" is unreachable$/.test(error.message);
}

function sameMachines(left: readonly Machine[], right: readonly Machine[]): boolean {
	return (
		left.length === right.length &&
		left.every((machine, index) => {
			const next = right[index];
			return (
				next !== undefined &&
				machine.id === next.id &&
				machine.name === next.name &&
				machine.api === next.api &&
				machine.local === next.local &&
				machine.reachable === next.reachable &&
				machine.reason === next.reason
			);
		})
	);
}

export class MachineDirectory {
	readonly #localApi: DeckApi;
	readonly #peerApiFactory: PeerApiFactory;
	readonly #listeners = new Set<() => void>();
	readonly #peerApis = new Map<string, DeckApi>();
	#snapshot: MachinesSnapshot;
	#refreshing: Promise<void> | null = null;
	#disposed = false;

	constructor(localApi: DeckApi, peerApiFactory: PeerApiFactory = peerId => new DeckApi({ base: `/api/peers/${encodeURIComponent(peerId)}` })) {
		this.#localApi = localApi;
		this.#peerApiFactory = peerApiFactory;
		this.#snapshot = { machines: [{ id: LOCAL_MACHINE_KEY, name: "Local", api: localApi, local: true, reachable: true }] };
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	getSnapshot(): MachinesSnapshot {
		return this.#snapshot;
	}

	get local(): Machine {
		return this.#snapshot.machines.find(machine => machine.local)!;
	}

	machine(id: string): Machine | undefined {
		return this.#snapshot.machines.find(machine => machine.id === id || (machine.local && id === LOCAL_MACHINE_KEY));
	}

	machineForKey(key: string): Machine | undefined {
		return machineForSessionKey(key, this.#snapshot.machines);
	}

	canAttempt(id: string): boolean {
		return this.#snapshot.machines.find(machine => machine.id === id)?.reachable ?? true;
	}

	refresh(): Promise<void> {
		if (this.#disposed) return Promise.resolve();
		this.#refreshing ??= this.#loadPeers().finally(() => {
			this.#refreshing = null;
		});
		return this.#refreshing;
	}

	reportReachability(id: string, reachable: boolean): void {
		if (id === this.local.id || id === LOCAL_MACHINE_KEY) return;
		const machines = this.#snapshot.machines;
		const index = machines.findIndex(machine => machine.id === id);
		if (index === -1) return;
		const previous = machines[index]!;
		if (previous.reachable === reachable && (reachable || previous.reason === `${previous.name} unreachable`)) return;
		const next = [...machines];
		next[index] = { ...previous, reachable, ...(reachable ? { reason: undefined } : { reason: `${previous.name} unreachable` }) };
		this.#commit({ machines: next });
	}

	async requireMachine(id: string | null): Promise<Machine> {
		if (id === null || id === LOCAL_MACHINE_KEY) return this.local;
		let machine = this.machine(id);
		if (machine === undefined) {
			await this.refresh();
			machine = this.machine(id);
		}
		if (machine === undefined) throw new Error(`Unknown machine: ${id}`);
		return machine;
	}

	dispose(): void {
		this.#disposed = true;
		this.#listeners.clear();
	}

	async #loadPeers(): Promise<void> {
		let response: PeersResponse;
		try {
			response = await this.#localApi.peers();
		} catch {
			return;
		}
		if (this.#disposed) return;
		const peers = response.peers.map(peer => {
			let api = this.#peerApis.get(peer.id);
			if (api === undefined) {
				api = this.#peerApiFactory(peer.id);
				this.#peerApis.set(peer.id, api);
			}
			return { ...peer, api, local: false, reachable: peer.reachable };
		});
		const peerIds = new Set(peers.map(peer => peer.id));
		for (const id of this.#peerApis.keys()) {
			if (peerIds.has(id)) continue;
			this.#peerApis.delete(id);
		}
		const next = [
			{ id: response.self.id, name: response.self.name, api: this.#localApi, local: true, reachable: true },
			...peers,
		];
		if (!sameMachines(this.#snapshot.machines, next)) this.#commit({ machines: next });
	}

	#commit(snapshot: MachinesSnapshot): void {
		if (this.#disposed) return;
		this.#snapshot = snapshot;
		for (const listener of this.#listeners) listener();
	}
}

export function createMachineSwitcherApi(directory: MachineDirectory, origin?: () => string): SessionSwitcherApi {
	const routeMachine = async (id: string | null): Promise<Machine> => {
		const machine = await directory.requireMachine(id);
		if (!machine.local && !directory.canAttempt(machine.id)) throw new Error(`${machine.name} unreachable`);
		return machine;
	};
	const report = (machine: Machine, reachable: boolean): void => {
		if (!machine.local) directory.reportReachability(machine.id, reachable);
	};
	const reportFailure = (machine: Machine, error: unknown): void => {
		if (isMachineNetworkError(error)) report(machine, false);
		else if (!(error instanceof DeckApiError && error.kind === "network")) report(machine, true);
	};
	const keyedSummary = (machine: Machine, summary: SessionSummary): SessionSummary => ({
		...summary,
		id: sessionKey(machine, summary.id),
	});
	const lastPeerSessions = new Map<string, ListSessionsResponse>();
	return {
		async cachedListSessions(): Promise<ListSessionsResponse | null> {
			const machines = [directory.local, ...directory.getSnapshot().machines.filter(machine => !machine.local)];
			const groups = await Promise.all(
				machines.map(async machine => ({
					machine,
					response: await machine.api.cachedGet<ListSessionsResponse>("/sessions"),
				})),
			);
			if (!groups.some(group => group.response !== null)) return null;
			const live: SessionSummary[] = [];
			const recent: SessionSummary[] = [];
			const archived: SessionSummary[] = [];
			for (const { machine, response } of groups) {
				if (response === null) continue;
				live.push(...response.live.map(summary => keyedSummary(machine, summary)));
				recent.push(...response.recent.map(summary => keyedSummary(machine, summary)));
				archived.push(...(response.archived ?? []).map(summary => keyedSummary(machine, summary)));
			}
			return { live, recent, archived };
		},
		async listSessions(): Promise<ListSessionsResponse> {
			const localMachine = directory.local;
			const localResponse = await localMachine.api.listSessions();
			const peerMachines = directory.getSnapshot().machines.filter(machine => !machine.local);
			const peerIds = new Set(peerMachines.map(machine => machine.id));
			for (const id of lastPeerSessions.keys()) {
				if (!peerIds.has(id)) lastPeerSessions.delete(id);
			}
			const peers = await Promise.all(peerMachines.map(async machine => {
				const previous = lastPeerSessions.get(machine.id) ?? null;
				if (!directory.canAttempt(machine.id)) return { machine, response: previous };
				try {
					const response = await machine.api.listSessions();
					report(machine, true);
					lastPeerSessions.set(machine.id, response);
					return { machine, response };
				} catch (error) {
					reportFailure(machine, error);
					return { machine, response: previous };
				}
			}));
			const groups = [{ machine: localMachine, response: localResponse }, ...peers];
			const live: SessionSummary[] = [];
			const recent: SessionSummary[] = [];
			const statuses: OfflineSessionStatus[] = [];
			for (const { machine, response } of groups) {
				if (response === null) continue;
				for (const summary of response.live) {
					const keyed = keyedSummary(machine, summary);
					live.push(keyed);
					statuses.push({
						key: keyed.id,
						archivedAt: null,
						live: true,
						waitingOnYou: keyed.awaitingAnswer,
						unfinished: keyed.state !== "stopped",
					});
				}
				for (const summary of response.recent) {
					const keyed = keyedSummary(machine, summary);
					recent.push(keyed);
					statuses.push({
						key: keyed.id,
						archivedAt: null,
						live: false,
						waitingOnYou: keyed.awaitingAnswer,
						unfinished: keyed.state !== "stopped",
					});
				}
				for (const summary of response.archived ?? []) {
					statuses.push({
						key: sessionKey(machine, summary.id),
						archivedAt: summary.archivedAt ?? summary.lastActivityAt,
						live: false,
						waitingOnYou: false,
						unfinished: false,
					});
				}
			}
			void offlineTranscriptCache.updateSessionStatuses(statuses);
			live.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
			recent.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
			return { live, recent };
		},
		async health(): Promise<DaemonHealth> {
			const localMachine = directory.local;
			const localHealth = await localMachine.api.health();
			const peerMachines = directory.getSnapshot().machines.filter(machine => !machine.local);
			const peers = await Promise.all(peerMachines.map(async machine => {
				if (!directory.canAttempt(machine.id)) return { machine, health: null };
				try {
					const health = await machine.api.health();
					report(machine, true);
					return { machine, health };
				} catch (error) {
					reportFailure(machine, error);
					return { machine, health: null };
				}
			}));
			const groups = [{ machine: localMachine, health: localHealth }, ...peers];
			const workers = groups.flatMap(({ machine, health }) => health?.workers.map(worker => ({
				...worker,
				sessionId: sessionKey(machine, worker.sessionId),
			})) ?? []);
			const guests = groups.reduce((sum, group) => sum + (group.health?.guests ?? 0), 0);
			return { ...localHealth, workers, guests };
		},
		async createSession(request, machineId) {
			const machine = await routeMachine(machineId ?? null);
			try {
				const summary = await machine.api.createSession(request);
				report(machine, true);
				return keyedSummary(machine, summary);
			} catch (error) {
				reportFailure(machine, error);
				throw error;
			}
		},
		async roomLink(key: string, permission?: RoomPermission): Promise<RoomLinkResponse> {
			const parts = splitSessionKey(key);
			if (parts.link) throw new Error("joined room links do not have daemon room links");
			const machine = await routeMachine(parts.machineId);
			try {
				const room = await machine.api.roomLink(parts.sessionId, permission);
				report(machine, true);
				if (machine.local) return room;
				const pageOrigin = origin?.() ?? globalThis.location?.origin;
				if (pageOrigin === undefined) throw new Error("Peer relay links require a browser origin");
				return { ...room, link: rewritePeerRoomLink(room.link, machine.id, pageOrigin) };
			} catch (error) {
				reportFailure(machine, error);
				throw error;
			}
		},

		async stopSession(key: string): Promise<void> {
			const parts = splitSessionKey(key);
			if (parts.link) throw new Error("joined room links cannot be stopped");
			const machine = await routeMachine(parts.machineId);
			try {
				await machine.api.stopSession(parts.sessionId);
				report(machine, true);
			} catch (error) {
				reportFailure(machine, error);
				throw error;
			}
		},
	};
}

export function useMachines(directory: MachineDirectory): MachinesSnapshot {
	const subscribe = useCallback((listener: () => void) => directory.subscribe(listener), [directory]);
	const getSnapshot = useCallback(() => directory.getSnapshot(), [directory]);
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
