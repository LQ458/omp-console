import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { DeckApiError, type DeckApi } from "../../lib/api";
import { deviceNameFromUserAgent, pairingErrorMessage } from "../../lib/pairing";
import { nativeInvoke } from "../../lib/move";
import "./pair-screen.css";


interface PairScreenProps {
	api: DeckApi;
	onPaired(): void;
	initialCode?: string;
}

function initialDeviceLabel(): string {
	if (typeof navigator === "undefined") return "Web browser";
	return deviceNameFromUserAgent(navigator.userAgent);
}


function pairingError(error: unknown): string {
	if (error instanceof DeckApiError) return pairingErrorMessage(error.status, error.message);
	return error instanceof Error ? error.message : "Pairing failed. Try again.";
}


export function PairScreen({ api, onPaired, initialCode }: PairScreenProps): ReactNode {
	const [code, setCode] = useState(() => {
		const compact = (initialCode ?? "").toUpperCase().replace(/[^0-9A-HJKMNP-TV-Z]/g, "").slice(0, 8);
		return compact.length > 4 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : compact;
	});
	const [label, setLabel] = useState(initialDeviceLabel);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const autoPairTried = useRef(false);

	const pair = useCallback(async (pairingCode: string, deviceLabel: string): Promise<void> => {
		setBusy(true);
		setError("");
		try {
			await api.pair(pairingCode, deviceLabel.trim());
			onPaired();
		} catch (reason) {
			setError(pairingError(reason));
		} finally {
			setBusy(false);
		}
	}, [api, onPaired]);

	useEffect(() => {
		if (initialCode !== undefined || autoPairTried.current) return;
		const invoke = nativeInvoke();
		if (!invoke) return;
		autoPairTried.current = true;
		let cancelled = false;
		void invoke("read_pairing_code", {}).then(async value => {
			if (cancelled || typeof value !== "string" || value.length === 0) return;
			setCode(value);
			await pair(value, label);
		}).catch(() => {
			// The configured desktop daemon may have no local pairing-code file; manual pairing remains available.
		});
		return () => {
			cancelled = true;
		};
	}, [initialCode, label, pair]);


	const submit = (event: FormEvent<HTMLFormElement>): void => {
		event.preventDefault();
		void pair(code, label);
	};
	const updateCode = (value: string): void => {
		const compact = value.toUpperCase().replace(/[^0-9A-HJKMNP-TV-Z]/g, "").slice(0, 8);
		setCode(compact.length > 4 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : compact);
	};

	return (
		<main className="pair-page">
			<section className="pair-card" aria-labelledby="pair-title">
				<div className="pair-mark" aria-hidden="true">OC</div>
				<p className="pair-eyebrow">omp console</p>
				<h1 id="pair-title">{initialCode === undefined ? "Pair this device" : "Pair this browser"}</h1>
				<p className="pair-description">Enter a one-time code from the daemon to authorize this browser.</p>
				<form className="pair-form" onSubmit={submit}>

					<label htmlFor="pair-code">Pairing code</label>
					<input
						autoComplete="one-time-code"
						autoCapitalize="characters"
						id="pair-code"
						inputMode="text"
						maxLength={9}
						name="code"
						pattern="[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}"
						placeholder="XXXX-XXXX"
						required
						spellCheck={false}
						value={code}
						onChange={event => updateCode(event.currentTarget.value)}
					/>
					<label htmlFor="pair-label">Device label</label>
					<input
						autoComplete="off"
						id="pair-label"
						maxLength={100}
						name="label"
						required
						value={label}
						onChange={event => setLabel(event.currentTarget.value)}
					/>
					{error && <p className="pair-error" role="alert">{error}</p>}
					<button className="pair-submit" disabled={busy || code.length !== 9 || label.trim().length === 0} type="submit">
						{busy ? "Pairing…" : initialCode === undefined ? "Pair device" : "Pair this browser"}
					</button>
				</form>
				<p className="pair-help">
					Find the code with <code>cat ~/.omp-console/pairing-code</code> or in the daemon terminal. It expires after 10 minutes.
					Get a new one with <code>~/.local/bin/omp-console pair</code>.
				</p>
			</section>
		</main>
	);
}
