import type { KeyValueStorage } from "../../lib/storage";

export function homeSeenKey(origin: string): string {
	return `omp-console.lastHomeSeen.${origin}`;
}

export function readHomeSeen(storage: KeyValueStorage | undefined, origin: string): number | undefined {
	try {
		const value = storage?.getItem(homeSeenKey(origin));
		if (value === null || value === undefined || value.trim() === "") return undefined;
		const timestamp = Number(value);
		return Number.isFinite(timestamp) ? timestamp : undefined;
	} catch {
		return undefined;
	}
}

export function markHomeSeen(storage: KeyValueStorage | undefined, origin: string, at: number): void {
	if (!storage) return;
	try {
		storage.setItem(homeSeenKey(origin), String(at));
	} catch {
		// The brief remains dismissible when storage is blocked.
	}
}
