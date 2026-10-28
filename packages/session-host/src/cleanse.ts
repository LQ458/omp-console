import type {
	CleanseAgentView,
	CleanseCheckView,
	CleanseCheckerDescriptor,
	CleanseCheckerSummary,
	CleanseDiagnosticView,
	CleanseRunSnapshot,
	CleanseRunStatus,
	CleanseSkippedChecker,
	CleanseStateSummary,
	SessionOpV3,
	SessionOpV3Result,
} from "@omp-console/protocol";
import { runCleanse, type CleanseRunUi } from "@oh-my-pi/pi-coding-agent/cleanse/index";
import type { CleanseCommandResult, CleanseDiagnostic, CleanseDiagnosticReport } from "@oh-my-pi/pi-coding-agent/cleanse/types";
import { discoverCleanseDiagnosticSuite } from "@oh-my-pi/pi-coding-agent/cleanse/checkers";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { RequestError } from "./request-error";

const MAX_CHECKERS = 64;
const MAX_AGENTS = 32;
const MAX_DIAGNOSTICS = 100;
const MAX_DIAGNOSTICS_PER_CHECK = 20;
const MAX_LOGS = 100;
const MAX_TEXT = 1000;
const MAX_FILE_PATHS = 50;

type CleanseStartOp = Extract<SessionOpV3, { op: "cleanse-start" }>;
type CleanseScope = CleanseStartOp["scope"];

interface DiscoveredCheckers {
	includeTests: boolean;
	checkers: CleanseCheckerDescriptor[];
	skipped: CleanseSkippedChecker[];
}

interface ActiveRun {
	runId: string;
	controller: AbortController;
	promise: Promise<void>;
}

/** Runs omp's cleanse orchestration with omp console state and cancellation instead of a terminal board. */
export class CleanseWorkerService {
	readonly #session: AgentSession;
	readonly #getCwd: () => string;
	readonly #onStateChanged: (status: CleanseStateSummary | undefined) => void;
	#discovery: DiscoveredCheckers | undefined;
	#snapshot: CleanseRunSnapshot | null = null;
	#active: ActiveRun | undefined;

	constructor(options: {
		session: AgentSession;
		getCwd(): string;
		onStateChanged(status: CleanseStateSummary | undefined): void;
	}) {
		this.#session = options.session;
		this.#getCwd = options.getCwd;
		this.#onStateChanged = options.onStateChanged;
	}

	async discover(
		includeTests: boolean,
	): Promise<Extract<SessionOpV3Result, { checkers: CleanseCheckerDescriptor[] }>> {
		const cwd = this.#getCwd();
		const suite = await discoverCleanseDiagnosticSuite(cwd, { includeTests });
		const checkers = suite.checkers.slice(0, MAX_CHECKERS).map(checker => ({ ...checker }));
		const skipped = suite.skipped.slice(0, MAX_CHECKERS).map(checker => ({ ...checker }));
		this.#discovery = { includeTests, checkers, skipped };
		return { ok: true, checkers, skipped };
	}

	start(options: CleanseStartOp): Extract<SessionOpV3Result, { runId: string }> {
		if (this.#active) throw new RequestError("conflict", "A cleanse run is already active");
		if (options.scope.kind === "request" && !options.scope.request.trim()) {
			throw new RequestError("bad-request", "A checker request is required");
		}
		const checkerId = options.scope.kind === "checker" ? options.scope.id : undefined;
		if (checkerId !== undefined && !this.#knownCheckers(options.includeTests).some(checker => checker.id === checkerId)) {
			throw new RequestError("bad-request", `Unknown cleanse checker id: ${checkerId}`);
		}

		const selected = this.#knownCheckers(options.includeTests).filter(
			checker => checkerId === undefined || checker.id === checkerId,
		);
		const initialStatus = {
			runId: options.runId,
			status: "running" as const,
			phase: "Starting cleanse…",
			checkers: selected.map(checker => ({ checker: this.#checkerView(checker), status: "pending" as const })),
			agents: [] as CleanseAgentView[],
			logs: [] as string[],
		};
		this.#snapshot = initialStatus;
		const controller = new AbortController();
		const active: ActiveRun = { runId: options.runId, controller, promise: Promise.resolve() };
		this.#active = active;
		this.#publish();
		active.promise = this.#execute(options, this.#getCwd(), controller.signal, active);
		return { ok: true, runId: options.runId };
	}

	cancel(runId: string): { ok: true } {
		if (!this.#active || this.#active.runId !== runId) {
			throw new RequestError("conflict", "That cleanse run is no longer active");
		}
		this.#active.controller.abort();
		return { ok: true };
	}

	state(): Extract<SessionOpV3Result, { state: CleanseRunSnapshot | null }> {
		return { ok: true, state: this.#copySnapshot() };
	}

	async close(): Promise<void> {
		const active = this.#active;
		if (!active) return;
		active.controller.abort();
		await active.promise;
		if (this.#active === active) this.#active = undefined;
		this.#onStateChanged(undefined);
	}

	#knownCheckers(includeTests: boolean): CleanseCheckerDescriptor[] {
		if (this.#discovery?.includeTests === includeTests) return this.#discovery.checkers;
		return [];
	}

	async #execute(options: CleanseStartOp, cwd: string, signal: AbortSignal, active: ActiveRun): Promise<void> {
		try {
			const scope: CleanseScope = options.scope;
			const ui = this.#createUi();
			const result = await runCleanse(
				{
					cwd,
					includeTests: options.includeTests,
					maxAgents: options.maxAgents,
					model: options.model,
					all: scope.kind === "all",
					checkerIds: scope.kind === "checker" ? [scope.id] : undefined,
					request: scope.kind === "request" ? scope.request : undefined,
				},
				ui,
				signal,
				{ settings: this.#session.settings, modelRegistry: this.#session.modelRegistry },
			);
			this.#finish(result);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.#update(snapshot => {
				snapshot.status = signal.aborted ? "cancelled" : "failed";
				snapshot.phase = undefined;
				snapshot.error = message.slice(0, MAX_TEXT);
				this.#appendLog(snapshot, signal.aborted ? "Cleanse cancelled." : `Cleanse failed: ${message}`);
			});
		} finally {
			if (this.#active === active) this.#active = undefined;
			this.#publish();
		}
	}

	#createUi(): CleanseRunUi {
		const board: CleanseRunUi["board"] = {
			interactive: false,
			log: text => this.#update(snapshot => this.#appendLog(snapshot, text)),
			phase: text => this.#update(snapshot => {
				snapshot.phase = text?.slice(0, MAX_TEXT);
			}),
			checkerStarted: checker => this.#update(snapshot => {
				let row = snapshot.checkers.find(candidate => candidate.checker.id === checker.id);
				if (!row) {
					row = { checker: this.#checkerView(checker), status: "pending" };
					snapshot.checkers.push(row);
				}
				row.status = "running";
				delete row.result;
			}),
			checkerFinished: (check, durationMs) => this.#update(snapshot => {
				const checker = this.#checkerView(check);
				let row = snapshot.checkers.find(candidate => candidate.checker.id === check.id);
				if (!row) {
					row = { checker, status: "pending" };
					snapshot.checkers.push(row);
				}
				row.checker = checker;
				row.status = "completed";
				row.result = {
					id: check.id.slice(0, 200),
					label: check.label.slice(0, MAX_TEXT),
					durationMs,
					diagnosticCount: check.diagnostics.length,
				};
			}),
			repairFinished: () => this.#update(snapshot => {
				snapshot.phase = "Verifying repairs…";
			}),
			agentStarted: (name, assignment) => this.#update(snapshot => {
				const agent = this.#agentFromAssignment(name, assignment);
				const existing = snapshot.agents.find(candidate => candidate.name === name);
				if (existing) Object.assign(existing, agent);
				else if (snapshot.agents.length < MAX_AGENTS) snapshot.agents.push(agent);
			}),
			agentProgress: (name, progress) => this.#update(snapshot => {
				const agent = snapshot.agents.find(candidate => candidate.name === name);
				if (!agent) return;
				agent.progress = {
					...(progress.lastIntent ? { lastIntent: progress.lastIntent.slice(0, MAX_TEXT) } : {}),
					...(progress.currentTool ? { currentTool: progress.currentTool.slice(0, 160) } : {}),
					recentOutput: progress.recentOutput.slice(-3).map(line => line.slice(0, 400)),
					toolCount: progress.toolCount,
				};
			}),
			agentFinished: (outcome, assignment) => this.#update(snapshot => {
				const agent = this.#agentFromOutcome(outcome, assignment);
				const existing = snapshot.agents.find(candidate => candidate.name === outcome.name);
				if (existing) Object.assign(existing, agent);
				else if (snapshot.agents.length < MAX_AGENTS) snapshot.agents.push(agent);
			}),
			close() {},
		};
		return {
			board,
			print: text => this.#update(snapshot => this.#appendLog(snapshot, text)),
			printError: text => this.#update(snapshot => this.#appendLog(snapshot, text)),
		};
	}

	#finish(result: CleanseCommandResult): void {
		const status: CleanseRunStatus = result.status;
		this.#update(snapshot => {
			snapshot.status = status;
			snapshot.phase = undefined;
			snapshot.result = {
				exitCode: result.exitCode,
				status,
				checks: result.report.checks.slice(0, MAX_CHECKERS).map(check => {
					const observed = snapshot.checkers.find(row => row.checker.id === check.id)?.result;
					return this.#checkView(check, observed?.durationMs ?? 0);
				}),
				diagnostics: result.report.diagnostics.slice(0, MAX_DIAGNOSTICS).map(diagnostic => this.#diagnosticView(diagnostic)),
				skipped: result.report.skipped.slice(0, MAX_CHECKERS).map(check => `${check.label}: ${check.reason}`.slice(0, MAX_TEXT)),
				...(result.sessionFile ? { sessionFile: result.sessionFile.slice(0, MAX_TEXT) } : {}),
			};
			if (result.status === "clean") this.#appendLog(snapshot, "Cleanse complete: no diagnostics remain.");
			else if (result.status === "cancelled") this.#appendLog(snapshot, "Cleanse cancelled.");
			else if (result.status === "unsupported") this.#appendLog(snapshot, "No runnable checker was found.");
			else this.#appendLog(snapshot, `Cleanse finished with ${result.report.diagnostics.length} remaining diagnostics.`);
		});
	}


	#checkView(check: CleanseDiagnosticReport["checks"][number], durationMs: number): CleanseCheckView {
		return {
			id: check.id.slice(0, 200),
			label: check.label.slice(0, MAX_TEXT),
			exitCode: check.exitCode,
			durationMs,
			diagnosticCount: check.diagnostics.length,
			diagnostics: check.diagnostics.slice(0, MAX_DIAGNOSTICS_PER_CHECK).map(diagnostic => this.#diagnosticView(diagnostic)),
		};
	}

	#diagnosticView(diagnostic: CleanseDiagnostic): CleanseDiagnosticView {
		return {
			checker: diagnostic.checker.slice(0, MAX_TEXT),
			...(diagnostic.file ? { file: diagnostic.file.slice(0, MAX_TEXT) } : {}),
			...(diagnostic.line === undefined ? {} : { line: diagnostic.line }),
			...(diagnostic.code ? { code: diagnostic.code.slice(0, 200) } : {}),
			severity: diagnostic.severity,
			message: diagnostic.message.slice(0, MAX_TEXT),
		};
	}

	#checkerView(
		checker: Pick<CleanseCheckerDescriptor, "id" | "label"> &
			Partial<Omit<CleanseCheckerDescriptor, "id" | "label">>,
	): CleanseCheckerSummary {
		return {
			id: checker.id.slice(0, 200),
			label: checker.label.slice(0, MAX_TEXT),
			...(checker.language ? { language: checker.language.slice(0, 120) } : {}),
			...(checker.cwd ? { cwd: checker.cwd.slice(0, MAX_TEXT) } : {}),
			...(checker.command ? { command: checker.command.slice(0, MAX_TEXT) } : {}),
		};
	}

	#agentFromAssignment(
		name: string,
		assignment: { groups: readonly { file?: string }[]; weight: number },
	): CleanseAgentView {
		return {
			name: name.slice(0, 200),
			status: "running",
			files: assignment.groups.flatMap(group => group.file ? [group.file.slice(0, MAX_TEXT)] : []).slice(0, MAX_FILE_PATHS),
			weight: assignment.weight,
		};
	}

	#agentFromOutcome(
		outcome: { name: string; success: boolean; output?: string; error?: string },
		assignment: { groups: readonly { file?: string }[]; weight: number },
	): CleanseAgentView {
		return {
			...this.#agentFromAssignment(outcome.name, assignment),
			status: outcome.success ? "completed" : this.#active?.controller.signal.aborted ? "aborted" : "failed",
			output: outcome.output?.slice(0, MAX_TEXT) ?? "",
			...(outcome.error ? { error: outcome.error.slice(0, MAX_TEXT) } : {}),
		};
	}

	#appendLog(snapshot: CleanseRunSnapshot, text: string): void {
		snapshot.logs.push(text.replace(/[\r\n\t]+/g, " ").slice(0, MAX_TEXT));
		if (snapshot.logs.length > MAX_LOGS) snapshot.logs.splice(0, snapshot.logs.length - MAX_LOGS);
	}

	#update(update: (snapshot: CleanseRunSnapshot) => void): void {
		const snapshot = this.#snapshot;
		if (!snapshot) return;
		update(snapshot);
		this.#publish();
	}

	#publish(): void {
		const snapshot = this.#snapshot;
		if (!snapshot) return;
		this.#onStateChanged({ runId: snapshot.runId, status: snapshot.status, ...(snapshot.phase ? { phase: snapshot.phase } : {}) });
	}

	#copySnapshot(): CleanseRunSnapshot | null {
		const snapshot = this.#snapshot;
		if (!snapshot) return null;
		return {
			...snapshot,
			checkers: snapshot.checkers.map(row => ({
				...row,
				checker: { ...row.checker },
				...(row.result ? { result: { ...row.result, diagnostics: [...(row.result.diagnostics ?? [])] } } : {}),
			})),
			agents: snapshot.agents.map(agent => ({
				...agent,
				files: [...agent.files],
				...(agent.progress ? { progress: { ...agent.progress, recentOutput: [...agent.progress.recentOutput] } } : {}),
			})),
			logs: [...snapshot.logs],
			...(snapshot.result
				? {
						result: {
							...snapshot.result,
							checks: snapshot.result.checks.map(check => ({ ...check, diagnostics: [...(check.diagnostics ?? [])] })),
							diagnostics: [...snapshot.result.diagnostics],
							skipped: [...snapshot.result.skipped],
						},
					}
				: {}),
		};
	}
}
