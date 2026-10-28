import type { SessionRecipeInput, SessionRecipeSource } from "@omp-console/protocol";
import { Save, X } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import "./newsession.css";

interface RecipeEditorProps {
	source: SessionRecipeSource;
	machineName: string;
	machineId: string;
	busy?: boolean;
	onSave(input: SessionRecipeInput): Promise<void>;
	onClose(): void;
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"] as const;

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : "The session template could not be saved.";
}

export function RecipeEditor({ source, machineName, machineId, busy = false, onSave, onClose }: RecipeEditorProps): ReactNode {
	const [name, setName] = useState(source.name);
	const [cwd, setCwd] = useState(source.cwd);
	const [prompt, setPrompt] = useState(source.prompt);
	const [model, setModel] = useState(source.model ?? "");
	const [thinkingLevel, setThinkingLevel] = useState(source.thinkingLevel ?? "");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const nameRef = useRef<HTMLInputElement>(null);

	useEffect(() => nameRef.current?.focus(), []);

	const submit = (event: FormEvent<HTMLFormElement>): void => {
		event.preventDefault();
		if (saving || busy) return;
		const input: SessionRecipeInput = { name: name.trim(), cwd: cwd.trim(), machineId, prompt };
		if (model.trim() !== "") input.model = model.trim();
		if (thinkingLevel !== "") input.thinkingLevel = thinkingLevel as NonNullable<SessionRecipeInput["thinkingLevel"]>;
		setSaving(true);
		setError(null);
		void onSave(input).catch(reason => setError(errorText(reason))).finally(() => setSaving(false));
	};

	return (
		<div className="dk-recipe-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
			<section className="dk-recipe-editor" role="dialog" aria-modal="true" aria-labelledby="dk-recipe-title">
				<header className="dk-recipe-head">
					<div><h2 id="dk-recipe-title">Save as session template</h2><p>One-tap start on {machineName}.</p></div>
					<button type="button" className="sh-btn sh-btn-icon" aria-label="close session template editor" disabled={saving} onClick={onClose}><X size={15} /></button>
				</header>
				<form className="dk-recipe-form" onSubmit={submit}>
					<label className="sh-field"><span className="sh-field-label">Name</span><input ref={nameRef} className="sh-input" value={name} maxLength={128} required onChange={event => setName(event.target.value)} /></label>
					<label className="sh-field"><span className="sh-field-label">Workspace path</span><input className="sh-input sh-input-mono" value={cwd} required onChange={event => setCwd(event.target.value)} /></label>
					<label className="sh-field"><span className="sh-field-label">First prompt</span><textarea className="sh-input dk-recipe-prompt" value={prompt} maxLength={65_536} required onChange={event => setPrompt(event.target.value)} /></label>
					<label className="sh-field"><span className="sh-field-label">Model (optional)</span><input className="sh-input sh-input-mono" value={model} onChange={event => setModel(event.target.value)} placeholder="Use the daemon default" /></label>
					<label className="sh-field"><span className="sh-field-label">Thinking (optional)</span>
						<select className="sh-input" value={thinkingLevel} onChange={event => setThinkingLevel(event.target.value)}>
							<option value="">Use the model default</option>
							{THINKING_LEVELS.map(level => <option key={level} value={level}>{level}</option>)}
						</select>
					</label>
					{error && <p className="dk-new-error" role="alert">{error}</p>}
					<div className="dk-recipe-buttons">
						<button type="button" className="sh-btn" disabled={saving || busy} onClick={onClose}>Cancel</button>
						<button type="submit" className="sh-btn sh-btn-primary" disabled={saving || busy || name.trim() === "" || cwd.trim() === "" || prompt.trim() === ""}>
							<Save size={14} />{saving ? "Saving…" : "Save session template"}
						</button>
					</div>
				</form>
			</section>
		</div>
	);
}
