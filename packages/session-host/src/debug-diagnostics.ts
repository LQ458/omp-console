import type { DebugDiagnosticAction, DebugDiagnosticSnapshot } from "@omp-console/protocol";
import { getWorkProfile } from "@oh-my-pi/pi-natives";
import { resolveRawSseDebugBuffer } from "@oh-my-pi/pi-tui/apps/debug/raw-sse-buffer";
import { getReportsDir, getSessionsDir } from "@oh-my-pi/pi-utils";
import { clearArtifactCache, createReportBundle, getArtifactCacheStats, getLogText } from "@oh-my-pi/pi-coding-agent/debug/report-bundle";
import type { ProfilerSession } from "@oh-my-pi/pi-coding-agent/debug/profiler";
import * as profilerApi from "@oh-my-pi/pi-coding-agent/debug/profiler";
import * as remoteDebugger from "@oh-my-pi/pi-coding-agent/debug/remote-debugger";
import { collectSystemInfo, formatSystemInfo } from "@oh-my-pi/pi-coding-agent/debug/system-info";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import * as path from "node:path";
import type { ReportBundleOptions } from "@oh-my-pi/pi-coding-agent/debug/report-bundle";
import { RequestError } from "./request-error";

const MAX_DOWNLOAD_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_BYTES = 256 * 1024;

function boundedText(text: string): string {
	const bytes = Buffer.from(text);
	if (bytes.byteLength <= MAX_TEXT_BYTES) return text;
	const lineBreak = bytes.indexOf(0x0a, bytes.byteLength - MAX_TEXT_BYTES);
	if (lineBreak < 0) {
		return `[omp console omitted older output; the newest line exceeds the ${MAX_TEXT_BYTES}-byte display limit.]`;
	}
	return `[omp console omitted older output; showing the newest ${MAX_TEXT_BYTES} bytes.]\n${bytes.subarray(lineBreak + 1).toString("utf8")}`;
}

export class DebugDiagnosticsService {
	readonly #session: AgentSession;
	#profiler: ProfilerSession | undefined;
	#profilerStart: Promise<void> | undefined;
	#closed = false;
	#closePromise: Promise<void> | undefined;

	constructor(session: AgentSession) {
		this.#session = session;
	}

	async run(action: DebugDiagnosticAction, confirmed: boolean | undefined, signal?: AbortSignal): Promise<DebugDiagnosticSnapshot> {
		signal?.throwIfAborted();
		switch (action) {
			case "artifacts":
				return this.#bundle(action, {}, signal, "The daemon cannot open its artifact folder in omp console; the report bundle includes this session's artifacts.");
			case "performance-start": {
				if (this.#profiler) return { action, text: "CPU profiling is already active. Stop it to build the report." };
				if (this.#closed) throw new RequestError("conflict", "Debug diagnostics service is closed.");
				if (this.#profilerStart) throw new RequestError("conflict", "CPU profiling is already starting.");
				const starting = (async (): Promise<void> => {
					const activeProfiler = await profilerApi.startCpuProfile();
					if (this.#closed) {
						await activeProfiler.stop();
						throw new RequestError("conflict", "Debug diagnostics service closed during profiler startup.");
					}
					try {
						signal?.throwIfAborted();
					} catch (error) {
						await activeProfiler.stop();
						throw error;
					}
					this.#profiler = activeProfiler;
				})();
				this.#profilerStart = starting;
				try {
					await starting;
				} finally {
					if (this.#profilerStart === starting) this.#profilerStart = undefined;
				}
				return { action, text: "CPU profiling started. Reproduce the issue, then stop profiling to download the report." };
			}
			case "performance-stop": {
				const profiler = this.#profiler;
				if (!profiler) throw new RequestError("bad-request", "Start CPU profiling before stopping it.");
				this.#profiler = undefined;
				const cpuProfile = await profiler.stop();
				return this.#bundle(action, { cpuProfile, workProfile: getWorkProfile(30) }, signal, "Review the report before sharing; it can include session data, artifacts, logs and settings.");
			}
			case "work": {
				const profile = getWorkProfile(30);
				if (!profile.svg) return { action, text: `No work profile data (${profile.sampleCount} samples).` };
				const outputPath = path.join(getReportsDir(), `omp-work-profile-${Date.now()}.svg`);
				await Bun.write(outputPath, profile.svg);
				return this.#fileResult(action, outputPath, "image/svg+xml", signal, `Work-scheduling flamegraph (${profile.sampleCount} samples). Saved on the daemon at ${outputPath}.`);
			}
			case "dump":
				return this.#bundle(action, {}, signal, "Review before sharing; the report can include session data, artifacts, logs and settings.");
			case "memory":
				return this.#bundle(action, { memoryStats: profilerApi.collectMemoryStats() }, signal, "Review before sharing; the report can include session data, artifacts, logs and settings.");
			case "logs":
				return { action, text: boundedText(await getLogText()) };
			case "raw-sse":
				return { action, text: boundedText(resolveRawSseDebugBuffer(this.#session).toRawText()) };
			case "remote-debugger": {
				const existing = remoteDebugger.getRemoteDebugger();
				if (!existing && confirmed !== true) {
					return {
						action,
						confirmationRequired: true,
						text: "The JavaScriptCore inspector is unauthenticated on 127.0.0.1. Any local process can attach and execute code inside this session worker with the worker's privileges. The runtime exposes no stop API, so the listener remains active until this worker exits. Confirm only if you trust all local processes.",
					};
				}
				signal?.throwIfAborted();
				const info = existing ?? await remoteDebugger.startRemoteDebuggerServer();
				const url = `ws://${info.host}:${info.port}`;
				return {
					action,
					text: `JavaScriptCore inspector is listening at ${url}. It is unauthenticated; any local process can attach and execute code inside this session worker with the worker's privileges. The upstream runtime exposes no stop API; the listener remains active until this process exits.`,
					remoteDebugger: { ...info, stopSupported: false },
				};
			}
			case "system": {
				return { action, text: boundedText(formatSystemInfo(await collectSystemInfo())) };
			}
			case "terminal":
				return {
					action,
					text: `This session runs in omp console, not an omp terminal. The browser owns input and rendering; the daemon owns this session.\nWorking directory: ${this.#session.sessionManager.getCwd()}\nSession file: ${this.#session.sessionManager.getSessionFile() ?? "not persisted yet"}`,
				};
			case "protocols":
				return {
					action,
					text: "Terminal escape-protocol tests do not apply to omp console. Browser API capabilities are measured in the client; session transport status is shown with this diagnostic.",
				};
			case "transcript": {
				const branch = this.#session.sessionManager.getBranch();
				const contents = `${branch.map(entry => JSON.stringify(entry)).join("\n")}\n`;
				const outputPath = path.join(getReportsDir(), `omp-console-transcript-${Date.now()}.jsonl`);
				await Bun.write(outputPath, contents);
				return this.#fileResult(action, outputPath, "application/x-ndjson", signal, `Current session branch: ${branch.length} entries. Saved on the daemon at ${outputPath}.`);
			}
			case "clear-cache": {
				const stats = await getArtifactCacheStats(getSessionsDir());
				if (stats.count === 0) return { action, text: "Artifact cache is empty.", cache: { fileCount: 0, totalBytes: 0 } };
				if (!confirmed) {
					return {
						action,
						confirmationRequired: true,
						text: `Found ${stats.count} cached artifact files (${stats.totalSize} bytes). Oldest: ${stats.oldestDate?.toISOString() ?? "unknown"}. Confirm removal of artifacts older than 30 days.`,
						cache: { fileCount: stats.count, totalBytes: stats.totalSize, ...(stats.oldestDate ? { oldestAt: stats.oldestDate.toISOString() } : {}) },
					};
				}
				signal?.throwIfAborted();
				const result = await clearArtifactCache(getSessionsDir(), 30);
				return { action, text: `Cleared ${result.removed} artifact directories.`, cache: { fileCount: stats.count, totalBytes: stats.totalSize } };
			}
		}
	}

	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#closed = true;
		const profiler = this.#profiler;
		this.#profiler = undefined;
		const starting = this.#profilerStart;
		const operation = (async () => {
			try {
				if (profiler) await profiler.stop();
			} finally {
				if (starting) await starting.catch(() => {});
			}
		})();
		this.#closePromise = operation;
		return operation;
	}

	async #bundle(
		action: DebugDiagnosticAction,
		options: Pick<ReportBundleOptions, "cpuProfile" | "memoryStats" | "workProfile">,
		signal: AbortSignal | undefined,
		text: string,
	): Promise<DebugDiagnosticSnapshot> {
		const result = await createReportBundle({
			sessionFile: this.#session.sessionManager.getSessionFile(),
			settings: { model: this.#session.model?.id, thinkingLevel: this.#session.thinkingLevel },
			rawSseText: resolveRawSseDebugBuffer(this.#session).toRawText(),
			...options,
		});
		return this.#fileResult(action, result.path, "application/gzip", signal, `${text}\nSaved on the daemon at ${result.path}. Included files: ${result.files.length}.`);
	}

	async #fileResult(
		action: DebugDiagnosticAction,
		filePath: string,
		mimeType: string,
		signal: AbortSignal | undefined,
		text: string,
	): Promise<DebugDiagnosticSnapshot> {
		signal?.throwIfAborted();
		const file = Bun.file(filePath);
		const byteLength = file.size;
		let base64: string | undefined;
		let unavailableReason: string | undefined;
		if (byteLength <= MAX_DOWNLOAD_BYTES) base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
		else unavailableReason = `File exceeds the ${MAX_DOWNLOAD_BYTES}-byte omp console download limit; it remains at ${filePath}.`;
		return {
			action,
			path: filePath,
			text: boundedText(text),
			download: {
				filename: path.basename(filePath),
				mimeType,
				byteLength,
				path: filePath,
				...(base64 === undefined ? {} : { base64 }),
				...(unavailableReason === undefined ? {} : { unavailableReason }),
			},
		};
	}
}
