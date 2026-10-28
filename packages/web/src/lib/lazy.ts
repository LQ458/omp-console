import { createElement, lazy } from "react";
import type { ComponentProps, ComponentType, ReactNode } from "react";

const RELOAD_MARKER = "omp-console:lazy-chunk-reload";

export interface ReloadGuardStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

export type LazyRecoveryAction = "reloaded" | "reload" | "retry";

export class LazyImportError extends Error {
	readonly action: LazyRecoveryAction;
	readonly original: unknown;

	constructor(original: unknown, action: LazyRecoveryAction) {
		super(original instanceof Error ? original.message : String(original));
		this.name = "LazyImportError";
		this.action = action;
		this.original = original;
	}
}

/** Reload at most once for a build; a subsequent failed chunk reaches the UI error boundary. */
export function reloadOncePerBuild(version: string, storage: ReloadGuardStorage, reload: () => void): boolean {
	if (version === "") return false;
	try {
		if (storage.getItem(RELOAD_MARKER) === version) return false;
		storage.setItem(RELOAD_MARKER, version);
		reload();
		return true;
	} catch {
		return false;
	}
}

export function buildVersionFromIndex(html: string): string | null {
	const tag = /<meta\b[^>]*\bname=["']omp-console-build-version["'][^>]*>/i.exec(html)?.[0];
	return tag === undefined ? null : /\bcontent=["']([^"']+)["']/i.exec(tag)?.[1] ?? null;
}

/** Preserve the chunk error for the boundary even when recovery cannot reload. */
export async function withLazyImportRecovery<T>(
	load: () => Promise<T>,
	onFailure: () => LazyRecoveryAction | void | Promise<LazyRecoveryAction | void>,
): Promise<T> {
	try {
		return await load();
	} catch (error) {
		let action: LazyRecoveryAction = "retry";
		try {
			const recovery = await onFailure();
			if (recovery === "reloaded" || recovery === "reload") action = recovery;
		} catch {
			// Keep the import failure visible when the reachability probe itself fails.
		}
		throw new LazyImportError(error, action);
	}
}

async function recoverMissingChunk(): Promise<LazyRecoveryAction> {
	if (typeof window === "undefined" || typeof document === "undefined") return "retry";
	const runningVersion = document.querySelector<HTMLMetaElement>('meta[name="omp-console-build-version"]')?.content ?? "development";
	let response: Response;
	try {
		response = await fetch(new URL("index.html", window.location.href), { cache: "no-store" });
		if (!response.ok) return "retry";
		const serverVersion = buildVersionFromIndex(await response.text());
		if (serverVersion === null || serverVersion === runningVersion) return "retry";
		const reloaded = reloadOncePerBuild(serverVersion, window.sessionStorage, () => window.location.reload());
		return reloaded ? "reloaded" : "reload";
	} catch {
		return "retry";
	}
}

/** React.lazy constrains its generic to ComponentType<any>; the wrapper preserves each component's actual props. */
export function lazyWithRecovery<T extends ComponentType<any>>(load: () => Promise<{ default: T }>): ComponentType<ComponentProps<T>> {
	const component = lazy(() => withLazyImportRecovery(load, recoverMissingChunk));
	return function RecoveredLazy(props: ComponentProps<T>): ReactNode {
		return createElement(component, props);
	};
}
