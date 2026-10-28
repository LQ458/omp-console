/** React binding for {@link SessionSwitcher} via `useSyncExternalStore`. */
import { useCallback, useSyncExternalStore } from "react";
import type { GuestClient } from "./client";
import type { SessionSwitcher, SwitcherSnapshot } from "./switcher";

export type GuestSwitcher = SessionSwitcher<GuestClient>;

export function useSwitcherSnapshot(switcher: GuestSwitcher): SwitcherSnapshot<GuestClient> {
	const subscribe = useCallback((listener: () => void) => switcher.subscribe(listener), [switcher]);
	const getSnapshot = useCallback(() => switcher.getSnapshot(), [switcher]);
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
