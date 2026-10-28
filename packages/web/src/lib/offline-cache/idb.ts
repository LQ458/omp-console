import type { SessionEntry } from "@oh-my-pi/pi-wire";
import {
	OFFLINE_ENTRY_CHUNK_SIZE,
	type OfflineCacheAdapter,
	type OfflineCacheMetadata,
	type OfflineCachedTranscript,
} from "./types";

const DATABASE_NAME = "omp-console-offline-transcripts-v1";
const DATABASE_VERSION = 1;
const SESSION_STORE = "sessions";
const CHUNK_STORE = "chunks";

interface EntryChunk {
	key: string;
	index: number;
	entries: SessionEntry[];
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	transaction.addEventListener("complete", () => resolve(), { once: true });
	transaction.addEventListener("error", () => reject(transaction.error ?? new Error("offline cache transaction failed")), { once: true });
	transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("offline cache transaction aborted")), { once: true });
	return promise;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	request.addEventListener("success", () => resolve(request.result), { once: true });
	request.addEventListener("error", () => reject(request.error ?? new Error("offline cache request failed")), { once: true });
	return promise;
}

let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
	if (databasePromise) return databasePromise;
	if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB is unavailable"));
	const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
	databasePromise = promise;
	const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
	request.addEventListener("upgradeneeded", () => {
		const database = request.result;
		if (!database.objectStoreNames.contains(SESSION_STORE)) database.createObjectStore(SESSION_STORE, { keyPath: "key" });
		if (!database.objectStoreNames.contains(CHUNK_STORE)) database.createObjectStore(CHUNK_STORE, { keyPath: ["key", "index"] });
	});
	request.addEventListener("success", () => {
		const database = request.result;
		database.onversionchange = () => database.close();
		resolve(database);
	});
	request.addEventListener("error", () => reject(request.error ?? new Error("could not open offline cache")));
	request.addEventListener("blocked", () => reject(new Error("offline cache upgrade is blocked")));
	return promise;
}

function chunkRange(key: string): IDBKeyRange {
	return IDBKeyRange.bound([key, 0], [key, Number.MAX_SAFE_INTEGER]);
}

function toRecord(metadata: OfflineCacheMetadata, chunks: EntryChunk[]): OfflineCachedTranscript {
	chunks.sort((a, b) => a.index - b.index);
	return { metadata, entries: chunks.flatMap(chunk => chunk.entries) };
}

export class IndexedDbOfflineCacheAdapter implements OfflineCacheAdapter {
	async get(key: string): Promise<OfflineCachedTranscript | null> {
		const database = await openDatabase();
		const transaction = database.transaction([SESSION_STORE, CHUNK_STORE], "readonly");
		const done = transactionDone(transaction);
		const metadataRequest = transaction.objectStore(SESSION_STORE).get(key) as IDBRequest<OfflineCacheMetadata | undefined>;
		const chunksRequest = transaction.objectStore(CHUNK_STORE).getAll(chunkRange(key)) as IDBRequest<EntryChunk[]>;
		const [metadata, chunks] = await Promise.all([requestResult(metadataRequest), requestResult(chunksRequest)]);
		await done;
		return metadata ? toRecord(metadata, chunks) : null;
	}

	async getMetadata(key: string): Promise<OfflineCacheMetadata | null> {
		const database = await openDatabase();
		const transaction = database.transaction(SESSION_STORE, "readonly");
		const done = transactionDone(transaction);
		const request = transaction.objectStore(SESSION_STORE).get(key) as IDBRequest<OfflineCacheMetadata | undefined>;
		const metadata = await requestResult(request);
		await done;
		return metadata ?? null;
	}

	async listMetadata(): Promise<OfflineCacheMetadata[]> {
		const database = await openDatabase();
		const transaction = database.transaction(SESSION_STORE, "readonly");
		const done = transactionDone(transaction);
		const request = transaction.objectStore(SESSION_STORE).getAll() as IDBRequest<OfflineCacheMetadata[]>;
		const metadata = await requestResult(request);
		await done;
		return metadata;
	}

	async put(record: OfflineCachedTranscript): Promise<void> {
		const database = await openDatabase();
		const transaction = database.transaction([SESSION_STORE, CHUNK_STORE], "readwrite");
		const done = transactionDone(transaction);
		const sessions = transaction.objectStore(SESSION_STORE);
		const chunks = transaction.objectStore(CHUNK_STORE);
		chunks.delete(chunkRange(record.metadata.key));
		sessions.put(record.metadata);
		for (let offset = 0, index = 0; offset < record.entries.length; offset += OFFLINE_ENTRY_CHUNK_SIZE, index++) {
			chunks.put({ key: record.metadata.key, index, entries: record.entries.slice(offset, offset + OFFLINE_ENTRY_CHUNK_SIZE) } satisfies EntryChunk);
		}
		await done;
	}

	async append(key: string, metadata: OfflineCacheMetadata, previousCount: number, entries: readonly SessionEntry[]): Promise<void> {
		const database = await openDatabase();
		const transaction = database.transaction([SESSION_STORE, CHUNK_STORE], "readwrite");
		const done = transactionDone(transaction);
		const sessions = transaction.objectStore(SESSION_STORE);
		const chunks = transaction.objectStore(CHUNK_STORE);
		sessions.put(metadata);
		let offset = 0;
		let index = Math.floor(previousCount / OFFLINE_ENTRY_CHUNK_SIZE);
		const remainder = previousCount % OFFLINE_ENTRY_CHUNK_SIZE;
		const addChunks = (): void => {
			while (offset < entries.length) {
				const next = entries.slice(offset, offset + OFFLINE_ENTRY_CHUNK_SIZE);
				chunks.put({ key, index, entries: next } satisfies EntryChunk);
				offset += next.length;
				index++;
			}
		};
		if (remainder > 0) {
			const request = chunks.get([key, index]) as IDBRequest<EntryChunk | undefined>;
			request.addEventListener("success", () => {
				const current = request.result;
				const room = OFFLINE_ENTRY_CHUNK_SIZE - remainder;
				const appended = entries.slice(0, room);
				if (current && appended.length > 0) {
					chunks.put({ ...current, entries: [...current.entries, ...appended] });
					offset = appended.length;
				} else if (!current) {
					chunks.put({ key, index, entries: appended } satisfies EntryChunk);
					offset = appended.length;
				}
				if (offset > 0 || !current) index++;
				addChunks();
			}, { once: true });
		} else {
			addChunks();
		}
		await done;
	}

	async updateMetadata(metadata: OfflineCacheMetadata): Promise<void> {
		const database = await openDatabase();
		const transaction = database.transaction(SESSION_STORE, "readwrite");
		const done = transactionDone(transaction);
		transaction.objectStore(SESSION_STORE).put(metadata);
		await done;
	}

	async delete(key: string): Promise<void> {
		const database = await openDatabase();
		const transaction = database.transaction([SESSION_STORE, CHUNK_STORE], "readwrite");
		const done = transactionDone(transaction);
		transaction.objectStore(SESSION_STORE).delete(key);
		transaction.objectStore(CHUNK_STORE).delete(chunkRange(key));
		await done;
	}

	async clear(): Promise<void> {
		const database = await openDatabase();
		const transaction = database.transaction([SESSION_STORE, CHUNK_STORE], "readwrite");
		const done = transactionDone(transaction);
		transaction.objectStore(SESSION_STORE).clear();
		transaction.objectStore(CHUNK_STORE).clear();
		await done;
	}
}
