/** React binding for {@link GuestClient} via `useSyncExternalStore`. */
import { useCallback, useSyncExternalStore } from "react";
import type { GuestClient, GuestSnapshot } from "./client";

export function useGuestSnapshot(client: GuestClient): GuestSnapshot {
	// Stable per client: an inline subscribe makes React unsubscribe and
	// resubscribe on every render.
	const subscribe = useCallback((listener: () => void) => client.subscribe(listener), [client]);
	const getSnapshot = useCallback(() => client.getSnapshot(), [client]);
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

const NO_UNSUBSCRIBE = (): void => {};

/**
 * One field of the guest snapshot. The component re-renders only when `select` returns a different
 * value (primitive or identity), not on every streamed frame. `select` must be a stable function.
 */
export function useGuestSelector<T>(
	client: GuestClient | null,
	select: (snapshot: GuestSnapshot) => T,
	whenNone: T,
): T {
	const subscribe = useCallback(
		(listener: () => void) => (client ? client.subscribe(listener) : NO_UNSUBSCRIBE),
		[client],
	);
	const getSnapshot = useCallback(() => (client ? select(client.getSnapshot()) : whenNone), [client, select, whenNone]);
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
