import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { FileText } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import type { GuestClient } from "../../lib/client";
import { recordUsage } from "../../lib/journal";
import { readLatestPlan } from "../../lib/session-ops";
import { OmpEquivalent } from "../catalog/OmpEquivalent";

export interface PlanPanelProps {
	entries: readonly SessionEntry[];
	client: GuestClient | null;
	sessionId: string | null;
	readOnly: boolean;
}

export function PlanPanel({ entries, client, sessionId, readOnly }: PlanPanelProps): ReactNode {
	const plan = useMemo(() => readLatestPlan(entries), [entries]);
	const [feedback, setFeedback] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [sent, setSent] = useState(false);

	const refine = (): void => {
		const text = feedback.trim();
		if (!client || readOnly || !text) return;
		try {
			client.sendPrompt(text);
			recordUsage({ feature: "1.6.plan-mode", action: "refine", outcome: "ok", via: "direct", screen: "status", sessionId: sessionId ?? undefined });
			setFeedback("");
			setError(null);
			setSent(true);
		} catch (cause) {
			recordUsage({ feature: "1.6.plan-mode", action: "refine", outcome: "error", via: "direct", screen: "status", sessionId: sessionId ?? undefined });
			setError(cause instanceof Error ? cause.message : "The refinement could not be sent.");
			setSent(false);
		}
	};

	return (
		<section className="dk-status-section so-section" aria-label="plan mode">
			<h3 className="dk-section-title">
				<FileText size={15} />
				Plan
			</h3>
			{plan ? (
				<details className="so-plan-document" open>
					<summary>{plan.path}</summary>
					<pre>{plan.content}</pre>
				</details>
			) : (
				<p className="dk-hint">No plan document is present in the mirrored session entries.</p>
			)}
			<div className="so-action-row">
				<button type="button" className="dk-wide-btn so-primary" onClick={refine} disabled={!plan || !client || readOnly || feedback.trim() === ""}>
					Refine plan
				</button>
			</div>
			{plan && (
				<label className="so-field">
					<span>Refinement prompt</span>
					<textarea value={feedback} onChange={event => { setFeedback(event.currentTarget.value); setSent(false); }} rows={3} disabled={!client || readOnly} />
				</label>
			)}
			{sent && <p className="so-success" role="status">Refinement sent to the session.</p>}
			{error && <p className="so-error" role="alert">{error}</p>}
			<OmpEquivalent text="/plan-review" hint="execute · refine" actionId="1.6.plan-review" />
			<p className="dk-hint">A submitted plan is approved automatically and the agent starts on it. Refine sends your text to the session as a prompt.</p>
		</section>
	);
}
