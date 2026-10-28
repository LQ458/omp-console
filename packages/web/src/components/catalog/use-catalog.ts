import type { CatalogResponse } from "@omp-console/protocol";
import { useCallback, useEffect, useState } from "react";
import type { DeckApi } from "../../lib/api";
import { catalogCache } from "../../lib/catalog";

export interface CatalogState {
	catalog: CatalogResponse | undefined;
	loading: boolean;
	error: string | undefined;
	/** Refetches past the cache (the catalog sheet's refresh button). */
	reload(): void;
}

/**
 * The session's capability catalog. Loads when `enabled` turns true (cached for 30 s), or on every enable when
 * `fresh` is set so the catalog sheet always shows what the daemon's registries hold right now.
 */
export function useCatalog(
	api: Pick<DeckApi, "catalog"> | undefined,
	sessionId: string | undefined,
	enabled: boolean,
	fresh = false,
): CatalogState {
	const [catalog, setCatalog] = useState<CatalogResponse | undefined>(() =>
		sessionId === undefined ? undefined : catalogCache.peek(sessionId),
	);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	const [tick, setTick] = useState(0);

	useEffect(() => {
		if (!enabled || api === undefined || sessionId === undefined) return;
		let live = true;
		setLoading(true);
		setError(undefined);
		catalogCache
			.load(api, sessionId, tick > 0 || fresh)
			.then(next => {
				if (live) setCatalog(next);
			})
			.catch((err: unknown) => {
				if (live) setError(err instanceof Error ? err.message : "catalog unavailable");
			})
			.finally(() => {
				if (live) setLoading(false);
			});
		return () => {
			live = false;
		};
	}, [api, sessionId, enabled, fresh, tick]);

	const reload = useCallback(() => setTick(value => value + 1), []);
	return { catalog, loading, error, reload };
}
