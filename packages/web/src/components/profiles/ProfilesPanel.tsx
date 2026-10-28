import type { AgentProfileSummary } from "@omp-console/protocol";
import { TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { DeckApi } from "../../lib/api";
import { recordUsage } from "../../lib/journal";
import {
	type EditTarget,
	type PendingEdit,
	ProfileConfigStore,
	type ProfileConfigSnapshot,
	targetLabel,
} from "../../lib/profile-config";
import { type DetailState, ProfileDetailStore, profileSpawnEquivalent } from "../../lib/profiles";
import { openSpawnPanel } from "../../lib/spawn";
import { ModelPicker } from "../agents/ModelPicker";
import { OmpLine } from "../spawn/OmpLine";
import "./profiles.css";

const sameTarget = (a: EditTarget, b: EditTarget): boolean =>
	a.kind === b.kind && (a.kind === "profile" ? a.name === (b as typeof a).name : a.role === (b as typeof a).role);

/** Roles in the order people think of them: `default` first, then alphabetical. */
function orderedRoles(roles: Readonly<Record<string, string>>): Array<[string, string]> {
	return Object.entries(roles).sort(([a], [b]) => (a === "default" ? -1 : b === "default" ? 1 : a.localeCompare(b)));
}

export interface ProfilesViewProps {
	snapshot: ProfileConfigSnapshot;
	/** Enables the per-profile "Details" view; omitted, the list is the editing list only. */
	detail?: ProfileDetailProps;
	onBegin(target: EditTarget): void;
	onChoose(selector: string | null): void;
	onBack(): void;
	onCancel(): void;
	onConfirm(): void;
	onRetry(): void;
}

/** Plain presentation of agent profiles and model roles; `ProfilesPanel` wires it to a store. */
export function ProfilesView(props: ProfilesViewProps): ReactNode {
	const { snapshot, onBegin, onChoose, onBack, onCancel, onConfirm, onRetry } = props;
	const { edit } = snapshot;
	const loadedOnce = snapshot.load === "ready" || snapshot.profiles.length > 0 || Object.keys(snapshot.roles).length > 0;

	return (
		<div className="pf-panel">
			<div className="pf-warning" role="note">
				<TriangleAlert size={15} aria-hidden />
				<p>
					These edit <strong>your omp configuration</strong> (<code>task.agentModelOverrides</code> and{" "}
					<code>modelRoles</code>). They apply to <strong>new spawns in all sessions</strong>, not to agents that are
					already running. To change a running agent, use “Change model” on the agent itself.
				</p>
			</div>

			{snapshot.saved ? (
				<div className="pf-saved" role="status">
					{snapshot.saved}
				</div>
			) : null}

			{snapshot.load === "error" ? (
				<div className="pf-error" role="alert">
					{snapshot.loadError}
					<button type="button" className="pf-btn" onClick={onRetry}>
						Retry
					</button>
				</div>
			) : null}
			{snapshot.load === "loading" && !loadedOnce ? <p className="dk-hint">Loading agent profiles…</p> : null}

			{loadedOnce ? (
				<>
					<h4 className="pf-subtitle">Agent profiles</h4>
					<ul className="pf-list" aria-label="agent profiles">
						{snapshot.profiles.map(profile => (
							<ProfileRow
								key={profile.name}
								profile={profile}
								edit={edit}
								snapshot={snapshot}
								detail={props.detail}
								onBegin={onBegin}
								onChoose={onChoose}
								onBack={onBack}
								onCancel={onCancel}
								onConfirm={onConfirm}
								onRetry={onRetry}
							/>
						))}
						{snapshot.profiles.length === 0 ? <li className="dk-hint">No agent profiles are available.</li> : null}
					</ul>

					<h4 className="pf-subtitle">Model roles</h4>
					<ul className="pf-list" aria-label="model roles">
						{orderedRoles(snapshot.roles).map(([role, selector]) => {
							const target: EditTarget = { kind: "role", role };
							const editing = edit !== null && sameTarget(edit.target, target);
							return (
								<li key={role} className="pf-item" data-editing={editing ? "true" : "false"}>
									<div className="pf-row">
										<div className="pf-row-main">
											<span className="pf-name">{role}</span>
											<span className="pf-value">{selector}</span>
										</div>
										<button
											type="button"
											className="pf-btn"
											disabled={edit?.stage === "saving"}
											onClick={() => onBegin(target)}
										>
											Change
										</button>
									</div>
									{editing && edit ? (
										<EditCard
											edit={edit}
											snapshot={snapshot}
											onChoose={onChoose}
											onBack={onBack}
											onCancel={onCancel}
											onConfirm={onConfirm}
											onRetry={onRetry}
										/>
									) : null}
								</li>
							);
						})}
					</ul>
				</>
			) : null}
		</div>
	);
}

function ProfileRow(
	props: {
		profile: AgentProfileSummary;
		edit: PendingEdit | null;
		snapshot: ProfileConfigSnapshot;
		detail?: ProfileDetailProps;
	} & Omit<ProfilesViewProps, "snapshot" | "detail">,
): ReactNode {
	const { profile, edit, snapshot, onBegin, detail } = props;
	const target: EditTarget = { kind: "profile", name: profile.name };
	const editing = edit !== null && sameTarget(edit.target, target);
	const [expanded, setExpanded] = useState(false);
	const toggleDetails = (): void => {
		const next = !expanded;
		setExpanded(next);
		if (next && detail) {
			detail.onLoad();
			recordUsage({ feature: "3.1.profile-detail", action: "view", outcome: "ok", via: "direct", screen: "settings", detail: profile.name });
		}
	};
	return (
		<li className="pf-item" data-editing={editing ? "true" : "false"}>
			<div className="pf-row">
				<div className="pf-row-main">
					<span className="pf-name">
						{profile.name} <span className="pf-chip">{profile.source}</span>
					</span>
					{profile.description ? <span className="pf-desc">{profile.description}</span> : null}
					<dl className="pf-facts">
						<div>
							<dt>Definition</dt>
							<dd>{profile.definitionModels.length > 0 ? profile.definitionModels.join(", ") : "none (inherits)"}</dd>
						</div>
						<div>
							<dt>Override</dt>
							<dd data-set={profile.override ? "true" : "false"}>{profile.override ?? "none"}</dd>
						</div>
						<div>
							<dt>Effective</dt>
							<dd>{profile.effectiveModel ?? "unknown"}</dd>
						</div>
					</dl>
				</div>
				<div className="pf-row-actions">
					<button type="button" className="pf-btn" disabled={edit?.stage === "saving"} onClick={() => onBegin(target)}>
						Change
					</button>
					{detail ? (
						<button
							type="button"
							className="pf-btn"
							aria-expanded={expanded}
							aria-label={`${expanded ? "hide" : "show"} details of ${profile.name}`}
							onClick={toggleDetails}
						>
							{expanded ? "Hide" : "Details"}
						</button>
					) : null}
				</div>
			</div>
			{expanded && detail ? <ProfileDetailView name={profile.name} detail={detail} /> : null}
			{editing && edit ? (
				<EditCard
					edit={edit}
					snapshot={snapshot}
					onChoose={props.onChoose}
					onBack={props.onBack}
					onCancel={props.onCancel}
					onConfirm={props.onConfirm}
					onRetry={props.onRetry}
				/>
			) : null}
		</li>
	);
}

export interface ProfileDetailProps {
	state: DetailState;
	/** Starts loading the definitions; safe to call repeatedly. */
	onLoad(): void;
}

function Tags({ items, empty }: { items: readonly string[] | undefined; empty: string }): ReactNode {
	if (items === undefined || items.length === 0) return <>{empty}</>;
	return (
		<span className="pd-tags">
			{items.map(item => (
				<span key={item} className="pd-tag">
					{item}
				</span>
			))}
		</span>
	);
}

/** What the definition declares, plus spawning it. Read from a live session's catalog. */
export function ProfileDetailView({ name, detail }: { name: string; detail: ProfileDetailProps }): ReactNode {
	const [spawnNote, setSpawnNote] = useState<string | null>(null);
	const { state } = detail;
	if (state.state === "idle" || state.state === "loading") return <div className="pd-detail dk-hint">Loading definition…</div>;
	if (state.state === "no-session") {
		return (
			<div className="pd-detail dk-hint" role="status">
				Start or open a session to read this profile's tools, skills and definition file. The daemon reads them from a live
				session.
			</div>
		);
	}
	if (state.state === "error") {
		return (
			<div className="pd-detail">
				<div className="pf-error" role="alert">
					{state.message}
					<button type="button" className="pf-btn" onClick={detail.onLoad}>
						Retry
					</button>
				</div>
			</div>
		);
	}
	const profile = state.byName.get(name);
	if (!profile) {
		return (
			<div className="pd-detail dk-hint" role="status">
				The live session does not list a profile named {name}.
			</div>
		);
	}
	const spawn = (): void => {
		const handled = openSpawnPanel({ profile: name });
		recordUsage({ feature: "3.3.spawn-with-profile", action: "open-spawn", outcome: handled ? "ok" : "error", via: "catalog", screen: "settings", detail: name });
		setSpawnNote(handled ? null : "Open a session you can control first; the new-agent dialog opens inside it.");
	};
	return (
		<div className="pd-detail" aria-label={`details of ${name}`}>
			<dl className="pd-facts">
				<div>
					<dt>Source</dt>
					<dd>{profile.source}</dd>
				</div>
				<div>
					<dt>Tools</dt>
					<dd>
						<Tags items={profile.tools} empty="all tools" />
					</dd>
				</div>
				<div>
					<dt>Spawns</dt>
					<dd>{profile.spawns === "*" ? "any profile" : <Tags items={profile.spawns} empty="none" />}</dd>
				</div>
				<div>
					<dt>Models</dt>
					<dd>{profile.definitionModels.length > 0 ? profile.definitionModels.join(", ") : "inherits the session model"}</dd>
				</div>
				<div>
					<dt>Thinking</dt>
					<dd>{profile.thinking ?? "default"}</dd>
				</div>
				<div>
					<dt>Skills</dt>
					<dd>
						<Tags items={profile.skills} empty="none" />
					</dd>
				</div>
			</dl>
			{profile.file ? (
				<>
					<OmpLine
						label="file:"
						text={profile.file}
						onCopy={() => recordUsage({ feature: "3.4.profile-file", action: "copy-path", outcome: "ok", via: "direct", screen: "settings", detail: name })}
					/>
					<p className="dk-hint">Edit this file to change the agent profile; the app cannot open it for you.</p>
				</>
			) : (
				<p className="dk-hint">Built into omp: there is no file to edit. Copy it into your agents folder to customize this agent profile.</p>
			)}
			<OmpLine text={profileSpawnEquivalent(name)} />
			<div className="pf-actions">
				<button type="button" className="pf-btn pf-btn-primary" onClick={spawn}>
					Spawn with this agent profile
				</button>
			</div>
			{spawnNote ? (
				<div className="pf-error" role="alert">
					{spawnNote}
				</div>
			) : null}
		</div>
	);
}

function EditCard(
	props: { edit: PendingEdit; snapshot: ProfileConfigSnapshot } & Pick<
		ProfilesViewProps,
		"onChoose" | "onBack" | "onCancel" | "onConfirm" | "onRetry"
	>,
): ReactNode {
	const { edit, snapshot, onChoose, onBack, onCancel, onConfirm, onRetry } = props;
	const label = targetLabel(edit.target);

	if (edit.stage === "choose") {
		return (
			<div className="pf-edit">
				<div className="pf-edit-title">Choose a model for {label}</div>
				<ModelPicker
					models={snapshot.models}
					loading={snapshot.load === "loading" && snapshot.models === null}
					error={snapshot.modelsError}
					current={edit.before}
					onPick={item => onChoose(item.selector)}
					onRetry={onRetry}
				/>
				<div className="pf-actions">
					{edit.target.kind === "profile" && edit.before !== undefined ? (
						<button type="button" className="pf-btn" onClick={() => onChoose(null)}>
							Clear override
						</button>
					) : null}
					<button type="button" className="pf-btn" onClick={onCancel}>
						Cancel
					</button>
				</div>
			</div>
		);
	}

	const saving = edit.stage === "saving";
	return (
		<div className="pf-edit pf-confirm" role="group" aria-label={`confirm change to ${label}`}>
			<div className="pf-edit-title">
				{edit.selector === null ? (
					<>
						Clear the model override for <strong>{label}</strong>?
					</>
				) : (
					<>
						Set <strong>{label}</strong> to <code>{edit.selector}</code>?
					</>
				)}
			</div>
			<p className="pf-confirm-note">
				{edit.before !== undefined ? (
					<>
						Now: <code>{edit.before}</code>.{" "}
					</>
				) : null}
				This writes your omp configuration and applies to new spawns in <strong>all sessions</strong>. Agents that
				are already running keep their model.
			</p>
			{edit.error ? (
				<div className="pf-error" role="alert">
					{edit.error}
				</div>
			) : null}
			<div className="pf-actions">
				<button type="button" className="pf-btn pf-btn-primary" disabled={saving} onClick={onConfirm}>
					{saving ? "Saving…" : "Confirm and save"}
				</button>
				<button type="button" className="pf-btn" disabled={saving} onClick={onBack}>
					Back
				</button>
				<button type="button" className="pf-btn" disabled={saving} onClick={onCancel}>
					Cancel
				</button>
			</div>
		</div>
	);
}

/** Settings section: loads profiles and roles from the daemon and edits them through the confirm flow. */
export function ProfilesPanel({ api, sessionId }: { api: DeckApi; sessionId?: string }): ReactNode {
	const [store] = useState(() => new ProfileConfigStore(api));
	const [details] = useState(() => new ProfileDetailStore(api, sessionId));
	const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
	const detailState = useSyncExternalStore(details.subscribe, details.getSnapshot, details.getSnapshot);
	useEffect(() => {
		void store.load();
	}, [store]);
	const detail = useMemo<ProfileDetailProps>(
		() => ({ state: detailState, onLoad: () => void details.ensure() }),
		[detailState, details],
	);
	return (
		<ProfilesView
			snapshot={snapshot}
			detail={detail}
			onBegin={target => store.begin(target)}
			onChoose={selector => store.choose(selector)}
			onBack={() => store.back()}
			onCancel={() => store.cancel()}
			onConfirm={() => void store.confirm()}
			onRetry={() => void store.load()}
		/>
	);
}
