import { useCallback, useEffect, useState } from "react";
import { tauriNotifyBridge } from "../src/lib/notifications";
import {
	browserEnv,
	describePushError,
	disablePush,
	enablePush,
	getPushState,
	type PushEnv,
	type PushState,
	type PushStatus,
	pushStatus,
	sendTestPush,
	syncPushSubscription,
} from "./push";

const boxStyle = {
	display: "flex",
	flexDirection: "column",
	gap: 8,
	padding: 12,
	border: "1px solid var(--border, rgba(127,127,127,0.3))",
	borderRadius: "var(--radius-lg, 12px)",
	background: "var(--bg-raised, transparent)",
	color: "var(--fg, inherit)",
	fontSize: 13,
	lineHeight: 1.45,
} as const;

const buttonStyle = {
	appearance: "none",
	border: "1px solid var(--border-strong, rgba(127,127,127,0.5))",
	borderRadius: "var(--radius, 8px)",
	background: "var(--bg-overlay, transparent)",
	color: "var(--fg, inherit)",
	font: "inherit",
	fontWeight: 600,
	minHeight: 44,
	padding: "0 14px",
	cursor: "pointer",
} as const;

const primaryStyle = {
	...buttonStyle,
	border: "none",
	background: "var(--accent-gradient, var(--accent, #5ad8e6))",
	color: "var(--accent-fg, #000)",
} as const;

const mutedStyle = { margin: 0, color: "var(--fg-muted, inherit)" } as const;
const errorStyle = { margin: 0, color: "var(--err, #ff6166)" } as const;

export interface NotificationsViewProps {
	status: PushStatus;
	busy: boolean;
	/** Short message about the last action that failed, or about the last test push. */
	message: string | null;
	messageIsError: boolean;
	onEnable(): void;
	onDisable(): void;
	onTest(): void;
}

/** Presentational half; the hint text for each state lives here. */
export function NotificationsView(props: NotificationsViewProps) {
	const { status, busy, message, messageIsError } = props;
	return (
		<section aria-label="Notifications" style={boxStyle} data-deck-notifications={status}>
			{status === "unsupported" &&
				(tauriNotifyBridge() ? (
					<MacNotifications />
				) : (
					<p style={mutedStyle}>This browser cannot receive deck notifications.</p>
				))}
			{status === "install-required" && (
				<>
					<p style={{ margin: 0 }}>
						<strong>Install deck to get notifications.</strong>
					</p>
					<p style={mutedStyle}>
						In Safari tap Share, then Add to Home Screen, and open deck from the Home Screen icon. When iOS 26 asks, keep{" "}
						<strong>Open as Web App</strong> switched on: with it off the app runs as a plain web page and cannot receive
						push notifications.
					</p>
				</>
			)}
			{status === "denied" && (
				<p style={mutedStyle}>
					Notifications are blocked for deck. Allow them in Settings, Notifications, deck (or the browser's site settings),
					then reopen the app.
				</p>
			)}
			{status === "off" && (
				<>
					<p style={mutedStyle}>Get a notification when a session finishes a turn, needs an answer or approval, or crashes.</p>
					<button type="button" style={primaryStyle} disabled={busy} onClick={props.onEnable}>
						Enable notifications
					</button>
				</>
			)}
			{status === "enabled" && (
				<>
					<p style={{ margin: 0 }}>Notifications are on for this device.</p>
					<div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
						<button type="button" style={buttonStyle} disabled={busy} onClick={props.onTest}>
							Send test
						</button>
						<button type="button" style={buttonStyle} disabled={busy} onClick={props.onDisable}>
							Turn off
						</button>
					</div>
				</>
			)}
			{message && (
				<p role={messageIsError ? "alert" : "status"} style={messageIsError ? errorStyle : mutedStyle}>
					{message}
				</p>
			)}
		</section>
	);
}

/** Mac app: notifications go through the native `native_notify` command, not Web Push. */
function MacNotifications() {
	const [note, setNote] = useState<string | null>(null);
	const test = (): void => {
		const invoke = (window as unknown as { __TAURI_INTERNALS__?: { invoke(c: string, a: Record<string, unknown>): Promise<unknown> } })
			.__TAURI_INTERNALS__?.invoke;
		if (!invoke) return;
		invoke("native_notify", { title: "omp console", body: "Test notification" }).then(
			() => setNote("Sent. If nothing appeared, allow omp console in System Settings › Notifications."),
			error => setNote(`Could not send: ${error instanceof Error ? error.message : String(error)}`),
		);
	};
	return (
		<>
			<p style={mutedStyle}>
				The Mac app shows macOS notifications when a turn finishes or a session waits for your answer while omp console is not
				in front.
			</p>
			<button type="button" style={buttonStyle} onClick={test}>
				Send a test notification
			</button>
			{note && <p style={mutedStyle}>{note}</p>}
		</>
	);
}

export interface EnableNotificationsProps {
	/** Test seam; defaults to the real browser. */
	env?: PushEnv;
}

export function EnableNotifications({ env }: EnableNotificationsProps) {
	const [resolvedEnv] = useState<PushEnv>(() => env ?? browserEnv());
	const [state, setState] = useState<PushState | null>(null);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

	const refresh = useCallback(async () => {
		setState(await getPushState(resolvedEnv));
	}, [resolvedEnv]);

	useEffect(() => {
		let live = true;
		void (async () => {
			try {
				await syncPushSubscription(resolvedEnv);
			} catch {
				// The next launch retries; the visible state below is still the browser's real one.
			}
			const next = await getPushState(resolvedEnv);
			if (live) setState(next);
		})();
		return () => {
			live = false;
		};
	}, [resolvedEnv]);

	// `action()` is invoked synchronously from the click handler so enablePush still sees the user gesture.
	const run = (action: () => Promise<void>, success: string | null) => {
		setBusy(true);
		setMessage(null);
		action().then(
			() => setMessage(success ? { text: success, error: false } : null),
			(error: unknown) => setMessage({ text: describePushError(error), error: true }),
		).finally(() => {
			setBusy(false);
			void refresh();
		});
	};

	if (!state) return null;
	return (
		<NotificationsView
			status={pushStatus(state)}
			busy={busy}
			message={message?.text ?? null}
			messageIsError={message?.error ?? false}
			onEnable={() => run(async () => void (await enablePush(resolvedEnv)), null)}
			onDisable={() => run(() => disablePush(resolvedEnv), null)}
			onTest={() => run(() => sendTestPush(resolvedEnv), "Test notification sent.")}
		/>
	);
}
