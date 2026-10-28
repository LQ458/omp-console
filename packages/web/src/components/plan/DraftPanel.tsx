import type { AgentProfileDetail, DraftRunNode } from "@omp-console/protocol";
import { ExternalLink, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import {
	connectError,
	type DraftEditorNode,
	type DraftNodeFields,
	runNodeElapsedMs,
	runStateView,
	taskToolArgs,
} from "../../lib/draft";
import { fmtDuration } from "../../lib/format";
import { OmpEquivalent } from "../agents/OmpEquivalent";
import "./plan.css";

/** The selected node: edit its fields (draft) or read its run state (run view). */
export function DraftPanel(props: {
	node: DraftEditorNode;
	allNodes: readonly DraftEditorNode[];
	profiles: readonly AgentProfileDetail[] | null;
	profilesError: string | null;
	editable: boolean;
	runNode?: DraftRunNode;
	now: number;
	onUpdate(patch: Partial<DraftNodeFields>): void;
	onSetDependency(depId: string, on: boolean): void;
	onRemove(): void;
	onOpenAgent(agentId: string): void;
}): ReactNode {
	const { node, allNodes, profiles, profilesError, editable, runNode, now, onUpdate, onSetDependency, onRemove, onOpenAgent } = props;
	// Textarea text keeps blank lines while typing; the node keeps only the non-empty ones.
	const [filesText, setFilesText] = useState((node.files ?? []).join("\n"));
	const profile = profiles?.find(item => item.name === node.profile);
	const others = allNodes.filter(other => other.id !== node.id);
	const view = runNode ? runStateView(runNode.state) : null;
	const elapsed = runNode ? runNodeElapsedMs(runNode, now) : undefined;
	const args = JSON.stringify(taskToolArgs(node));

	return (
		<div className="dp" aria-label="selected task">
			{view && runNode ? (
				<div className="dp-run">
					<span className={`dp-state dp-state--${view.tone}`}>{view.label}</span>
					{elapsed !== undefined ? <span className="dp-elapsed">{fmtDuration(elapsed)}</span> : null}
					{runNode.agentId ? (
						<button type="button" className="ag-btn" onClick={() => onOpenAgent(runNode.agentId!)}>
							<ExternalLink size={13} aria-hidden /> Open agent
						</button>
					) : null}
					{runNode.summary ? <pre className="dp-summary">{runNode.summary}</pre> : null}
				</div>
			) : null}
			<label className="dp-field">
				<span>Title</span>
				<input
					className="dp-input"
					value={node.title}
					disabled={!editable}
					placeholder="What this step is"
					onChange={event => onUpdate({ title: event.target.value })}
				/>
			</label>
			<label className="dp-field">
				<span>Agent profile</span>
				<select
					className="dp-input"
					value={node.profile}
					disabled={!editable || profiles === null}
					onChange={event => onUpdate({ profile: event.target.value })}
				>
					<option value="">{profiles === null ? "Loading agent profiles…" : "Choose an agent profile"}</option>
					{node.profile !== "" && profiles !== null && !profile ? <option value={node.profile}>{node.profile} (not in this session)</option> : null}
					{(profiles ?? []).map(item => (
						<option key={item.name} value={item.name}>
							{item.name}
						</option>
					))}
				</select>
				{profilesError !== null ? <small className="dp-note dp-note--err">{profilesError}</small> : null}
				{profile?.description ? <small className="dp-note">{profile.description}</small> : null}
			</label>
			<label className="dp-field">
				<span>Instruction</span>
				<textarea
					className="dp-input dp-textarea"
					value={node.instruction}
					disabled={!editable}
					rows={4}
					placeholder="What the agent should do and how to know it is done"
					onChange={event => onUpdate({ instruction: event.target.value })}
				/>
			</label>
			<label className="dp-field">
				<span>Files (one per line)</span>
				<textarea
					className="dp-input dp-textarea dp-textarea--mono"
					value={filesText}
					disabled={!editable}
					rows={2}
					placeholder="src/relay.ts"
					onChange={event => {
						setFilesText(event.target.value);
						onUpdate({ files: event.target.value.split("\n").map(line => line.trim()).filter(line => line !== "") });
					}}
				/>
			</label>
			<label className="dp-check">
				<input
					type="checkbox"
					checked={node.isolated === true}
					disabled={!editable}
					onChange={event => onUpdate({ isolated: event.target.checked })}
				/>
				<span>Run in an isolated worktree</span>
			</label>
			<fieldset className="dp-deps" disabled={!editable}>
				<legend>Waits for</legend>
				{others.length === 0 ? <small className="dp-note">Add another task to make a dependency.</small> : null}
				{others.map(other => {
					const on = node.dependsOn.includes(other.id);
					const blocked = !on && connectError({ nodes: allNodes }, other.id, node.id) !== null;
					return (
						<label key={other.id} className="dp-check" title={blocked ? "That would make a cycle" : undefined}>
							<input type="checkbox" checked={on} disabled={blocked} onChange={event => onSetDependency(other.id, event.target.checked)} />
							<span>{other.title.trim() || other.id}</span>
						</label>
					);
				})}
			</fieldset>
			<OmpEquivalent text="task tool: agent=<profile>, task=<instruction>" copy={args} />
			{editable ? (
				<button type="button" className="ag-btn ag-btn--danger dp-remove" onClick={onRemove}>
					<Trash2 size={13} aria-hidden /> Delete task
				</button>
			) : null}
		</div>
	);
}
