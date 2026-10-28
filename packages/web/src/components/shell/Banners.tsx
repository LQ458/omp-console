import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { RestartNotice } from "../../lib/api";
import { RESTART_LOST_MESSAGE } from "../../lib/client";
import type { ConnectionPhase, GuestSnapshot } from "../../lib/client";
import type { PaneRecoveryStatus } from "../../lib/pane-layout";

export function OfflineBanner(): ReactNode {
	return (
		<div className="sh-recovery-banner" role="status">
			Offline — messages are kept, not sent
		</div>
	);
}

export function PaneRecoveryBanner({
	status,
	machineName,
	onResume,
}: {
	status: PaneRecoveryStatus | null;
	machineName?: string;
	onResume?: () => void;
}): ReactNode {
	if (machineName) {
		return (
			<div className="sh-recovery-banner" role="status">
				{machineName} is unreachable — showing the last state; it reconnects when the machine is back
			</div>
		);
	}
	if (status === "reconnecting") {
		return (
			<div className="sh-recovery-banner" role="status">
				Reconnecting to omp console…
			</div>
		);
	}
	if (status === "stopped") {
		return (
			<div className="sh-recovery-banner" role="alert">
				Session stopped
				{onResume && (
					<button type="button" className="sh-btn sh-btn-primary" onClick={onResume}>
						Resume
					</button>
				)}
			</div>
		);
	}
	return null;
}

export interface BannersProps {
	phase: ConnectionPhase;
	endedReason: string | null;
	loading: GuestSnapshot["loading"];
	onRejoin(): void;
	onNewLink(): void;
}

export function Banners({ phase, endedReason, loading, onRejoin, onNewLink }: BannersProps): ReactNode {
	const [restartPending, setRestartPending] = useState(false);
	const restartPendingRef = useRef(false);
	useEffect(() => {
		if (phase === "reconnecting" && endedReason === RESTART_LOST_MESSAGE) return;
		if (!restartPendingRef.current) return;
		restartPendingRef.current = false;
		setRestartPending(false);
	}, [phase, endedReason]);
	const startAgain = (): void => {
		if (restartPendingRef.current) return;
		restartPendingRef.current = true;
		setRestartPending(true);
		onRejoin();
	};
	const progress = loading && loading.total > 0 ? ` ${Math.floor((loading.received / loading.total) * 100)}%` : "";
	if (phase === "connecting" || phase === "waiting") {
		return (
			<div className="sh-banner" role="status">
				<span className="sh-banner-dot" />
				{phase === "connecting" ? "Connecting to relay…" : `Joining session…${progress}`}
			</div>
		);
	}
	if (phase === "reconnecting" && endedReason?.startsWith(RESTART_LOST_MESSAGE)) {
		return (
			<div className="sh-ended" role="alertdialog" aria-label="session ended">
				<div className="sh-ended-card">
					<div className="sh-ended-title">Session ended</div>
					<div className="sh-ended-reason">{endedReason}</div>
					<div className="sh-ended-actions">
						<button
							type="button"
							className="sh-btn sh-btn-primary"
							disabled={restartPending}
							aria-busy={restartPending}
							onClick={startAgain}
						>
							Start again with the same prompt (not sent yet)
						</button>
						<button type="button" className="sh-btn" onClick={onNewLink}>
							Close
						</button>
					</div>
				</div>
			</div>
		);
	}
	if (phase === "reconnecting") {
		return (
			<div className="sh-banner" role="status">
				<span className="sh-banner-dot" />
				{`Reconnecting…${progress}`}
			</div>
		);
	}
	if (phase === "ended") {
		return (
			<div className="sh-ended" role="alertdialog" aria-label="session ended">
				<div className="sh-ended-card">
					<div className="sh-ended-title">Session ended</div>
					{endedReason && <div className="sh-ended-reason">{endedReason}</div>}
					<div className="sh-ended-actions">
						<button type="button" className="sh-btn sh-btn-primary" onClick={onRejoin}>
							Rejoin
						</button>
						<button type="button" className="sh-btn" onClick={onNewLink}>
							Close
						</button>
					</div>
				</div>
			</div>
		);
	}
	return null;
}

export const RESTART_NOTICE_TTL_MS = 30_000;

export function scheduleRestartNoticeDismiss(onDismiss: () => void): () => void {
	const timer = globalThis.setTimeout(onDismiss, RESTART_NOTICE_TTL_MS);
	return () => globalThis.clearTimeout(timer);
}

export function RestartNoticeBanner({ notice, onDismiss }: { notice: RestartNotice; onDismiss(): void }): ReactNode {
	const dismiss = useRef(onDismiss);
	dismiss.current = onDismiss;
	useEffect(() => scheduleRestartNoticeDismiss(() => dismiss.current()), [notice.at]);
	const interrupted = notice.interruptedTitles.length > 0 ? `; turn interrupted in: ${notice.interruptedTitles.join(", ")}` : "";
	const resumed = `${notice.resumed} session${notice.resumed === 1 ? "" : "s"} resumed`;
	return (
		<div className="sh-recovery-banner" role="status">
			<span>
				omp console restarted at {new Date(notice.at).toLocaleString()}; {resumed}{interrupted}
			</span>
			<button type="button" className="sh-btn" onClick={onDismiss} aria-label="Dismiss restart notice">
				Dismiss
			</button>
		</div>
	);
}
