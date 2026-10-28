import type { SessionEntry } from "@oh-my-pi/pi-wire";

export const OFFLINE_ENTRY_CHUNK_SIZE = 200;
export const OFFLINE_SESSION_MAX_BYTES = 12 * 1024 * 1024;
export const OFFLINE_CACHE_TTL_MS = 60 * 24 * 60 * 60 * 1000;
export const OFFLINE_CACHE_LIVE_GRACE_MS = 14 * 24 * 60 * 60 * 1000;
export const OFFLINE_IMAGE_MAX_BYTES = 256 * 1024;

export interface OfflineCacheMetadata {
	key: string;
	title: string;
	cwd: string;
	replicaToken: string | null;
	entryCount: number;
	tailEntryId: string | null;
	leafId: string | null;
	lastViewedAt: number;
	lastEntryAt: number;
	bytes: number;
	partial: boolean;
	/** Some images were replaced by placeholders: like `partial`, the replica cursor must not be reused. */
	pruned?: boolean;
	archivedAt: number | null;
	live: boolean;
	waitingOnYou: boolean;
	unfinished: boolean;
}

export interface OfflineCachedTranscript {
	metadata: OfflineCacheMetadata;
	entries: SessionEntry[];
}

export interface OfflineTranscriptCommit {
	entries: readonly SessionEntry[];
	title: string;
	cwd: string;
	replicaToken: string | null;
	leafId: string | null;
	lastEntryAt: number;
	archivedAt: number | null;
	live: boolean;
	waitingOnYou: boolean;
	unfinished: boolean;
}
export interface OfflineSessionStatus {
	key: string;
	archivedAt: number | null;
	live: boolean;
	waitingOnYou: boolean;
	unfinished: boolean;
}

export interface OfflineCacheAdapter {
	get(key: string): Promise<OfflineCachedTranscript | null>;
	getMetadata(key: string): Promise<OfflineCacheMetadata | null>;
	listMetadata(): Promise<OfflineCacheMetadata[]>;
	put(record: OfflineCachedTranscript): Promise<void>;
	append(key: string, metadata: OfflineCacheMetadata, previousCount: number, entries: readonly SessionEntry[]): Promise<void>;
	updateMetadata(metadata: OfflineCacheMetadata): Promise<void>;
	delete(key: string): Promise<void>;
	clear(): Promise<void>;
}

export interface OfflineCacheStats {
	sessions: number;
	bytes: number;
}

export interface CacheBudgetEnvironment {
	now(): number;
	estimateQuota(): Promise<number | null>;
	touchDevice(): boolean;
}
