import type { SessionEntry } from "@oh-my-pi/pi-wire";

const cachedViews = new WeakMap<readonly SessionEntry[], boolean>();

export function markOfflineCachedEntries(entries: readonly SessionEntry[], partial: boolean): void {
	cachedViews.set(entries, partial);
}

export function offlineCachedEntriesPartial(entries: readonly SessionEntry[]): boolean | undefined {
	return cachedViews.get(entries);
}
