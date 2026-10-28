const ENABLED_KEY = "omp-console-offline-cache-enabled";
const CHANGE_EVENT = "omp-console:offline-cache-preference";

export function offlineCacheEnabled(storage: Pick<Storage, "getItem"> | undefined = browserStorage()): boolean {
	try {
		return storage?.getItem(ENABLED_KEY) === "true";
	} catch {
		return false;
	}
}

export function setOfflineCacheEnabled(enabled: boolean, storage: Pick<Storage, "setItem"> | undefined = browserStorage()): void {
	try {
		storage?.setItem(ENABLED_KEY, String(enabled));
	} catch {
		// Storage failures keep the preference disabled.
	}
	if (typeof globalThis.dispatchEvent === "function" && typeof Event !== "undefined") {
		globalThis.dispatchEvent(new Event(CHANGE_EVENT));
	}
}

export function subscribeOfflineCachePreference(listener: () => void): () => void {
	if (typeof globalThis.addEventListener !== "function") return () => {};
	globalThis.addEventListener(CHANGE_EVENT, listener);
	return () => globalThis.removeEventListener(CHANGE_EVENT, listener);
}

function browserStorage(): Pick<Storage, "getItem" | "setItem"> | undefined {
	try {
		return globalThis.localStorage;
	} catch {
		return undefined;
	}
}
