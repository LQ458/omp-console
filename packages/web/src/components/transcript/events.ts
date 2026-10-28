export interface TranscriptOutputDetail {
	id: string;
	sessionId: string;
	kind: "bash" | "python";
	excludeFromContext: boolean;
	command: string;
	output: string;
	exitCode?: number;
	at: number;
}

export const TRANSCRIPT_OUTPUT_EVENT = "omp-console:transcript-output";

export function publishTranscriptOutput(detail: TranscriptOutputDetail, target: EventTarget = globalThis): void {
	target.dispatchEvent(new CustomEvent<TranscriptOutputDetail>(TRANSCRIPT_OUTPUT_EVENT, { detail }));
}
