export interface BenchHooks {
	frameReceived(): void;
	committed(): void;
}

let hooks: BenchHooks | null = null;

export function setBenchHooks(value: BenchHooks): void {
	hooks = value;
}

/** Called when a token frame reaches the page; the benchmark module is absent unless ?bench loaded it. */
export function benchFrameReceived(): void {
	hooks?.frameReceived();
}

/** Called after the transcript committed new content. */
export function benchCommitted(): void {
	hooks?.committed();
}

export function isBenchRequested(search: string): boolean {
	return new URLSearchParams(search).has("bench");
}
