import type { ErrorInfo, ReactNode } from "react";
import { Component, Suspense, useCallback } from "react";
import { LazyImportError } from "../../lib/lazy";

interface BoundaryState {
	failed: boolean;
	error: unknown;
}

interface LazyErrorBoundaryProps {
	children: ReactNode;
	onRetry(): void;
	errorFallback?: (content: ReactNode) => ReactNode;
}

class LazyErrorBoundary extends Component<LazyErrorBoundaryProps, BoundaryState> {
	override state: BoundaryState = { failed: false, error: null };

	static getDerivedStateFromError(error: unknown): BoundaryState {
		return { failed: true, error };
	}

	override componentDidCatch(error: unknown, info: ErrorInfo): void {
		if (error instanceof LazyImportError) return;
		console.error("omp console panel render failed", error, info.componentStack);
	}

	override render(): ReactNode {
		if (!this.state.failed) return this.props.children;
		const lazyError = this.state.error instanceof LazyImportError ? this.state.error : null;
		const chunkFailure = lazyError !== null;
		const retry = lazyError?.action === "retry";
		const reload = lazyError?.action === "reload" || lazyError?.action === "reloaded";
		const content = (
			<div className="pn-note" role="alert">
				<p className="pn-note-title">{chunkFailure ? "omp console was updated" : "Something went wrong in this panel"}</p>
				<p className="pn-note-body">
					{retry
						? "The server may still be restarting. Try again when it is reachable."
						: reload
							? "The server is running a different build. Reload to continue."
							: "Reload to continue."}
				</p>
				<button type="button" className="sh-btn sh-btn-primary" onClick={retry ? this.props.onRetry : () => window.location.reload()}>
					{retry ? "Retry" : "Reload"}
				</button>
			</div>
		);
		return this.props.errorFallback?.(content) ?? content;
	}
}

export interface LazyRegionProps {
	children: ReactNode;
	fallback: ReactNode;
	/** Optional wrapper for the error UI; sheets use this to keep the error inside the open sheet. */
	errorFallback?: (content: ReactNode) => ReactNode;
}

export function LazyRegion({ children, fallback, errorFallback }: LazyRegionProps): ReactNode {
	const retry = useCallback((): void => {
		void fetch(new URL("index.html", window.location.href), { cache: "no-store" })
			.then(response => {
				if (response.ok) window.location.reload();
			})
			.catch(() => {});
	}, []);
	return (
		<LazyErrorBoundary onRetry={retry} errorFallback={errorFallback}>
			<Suspense fallback={fallback}>{children}</Suspense>
		</LazyErrorBoundary>
	);
}
