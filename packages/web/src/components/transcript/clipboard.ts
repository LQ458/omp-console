import type { AssistantMessage, SessionEntry } from "@oh-my-pi/pi-wire";

export interface TextBlockLike {
	type: string;
	text?: string;
}

/** Visible text only: assistant reasoning, tool calls and image bytes are not copied as message prose. */
export function copyableMessageText(content: string | readonly TextBlockLike[]): string {
	if (typeof content === "string") return content;
	return content.flatMap(block => block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n");
}

export function lastHttpLink(text: string): string | null {
	const matches = text.match(/https?:\/\/[^\s<>"'`]+/gi);
	if (matches === null) return null;
	for (let index = matches.length - 1; index >= 0; index--) {
		let candidate = matches[index] ?? "";
		while (true) {
			const previous = candidate;
			candidate = candidate.replace(/[.,!?;:]$/, "");
			if (candidate.endsWith(")") && (candidate.match(/\(/g)?.length ?? 0) < (candidate.match(/\)/g)?.length ?? 0)) {
				candidate = candidate.slice(0, -1);
			}
			if (candidate === previous) break;
		}
		try {
			const url = new URL(candidate);
			if ((url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "") return url.href;
		} catch {
			// Try an earlier link when the final token is malformed.
		}
	}
	return null;
}

export type ExternalLinkOpener = (url: string) => unknown;

/** Open only fully parsed HTTP(S) links, with a noopener browser target by default. */
export function openExternalLink(value: string, opener: ExternalLinkOpener = url => window.open(url, "_blank", "noopener,noreferrer")): boolean {
	const link = lastHttpLink(value);
	if (link === null) return false;
	opener(link);
	return true;
}
export function latestTranscriptLink(entries: readonly SessionEntry[], stream: AssistantMessage | null): string | null {
	if (stream !== null) {
		const link = lastHttpLink(copyableMessageText(stream.content));
		if (link !== null) return link;
	}
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "message" || (entry.message.role !== "assistant" && entry.message.role !== "user")) continue;
		const link = lastHttpLink(copyableMessageText(entry.message.content));
		if (link !== null) return link;
	}
	return null;
}

/** Fenced code blocks in source order, excluding text inside unclosed fences. */
export function extractFencedCodeBlocks(text: string): string[] {
	const lines = text.split("\n");
	const blocks: string[] = [];
	for (let index = 0; index < lines.length; index++) {
		if (!/^```([^\n]*)$/.test(lines[index]!)) continue;
		const close = lines.findIndex((line, candidate) => candidate > index && /^```/.test(line));
		if (close === -1) continue;
		blocks.push(lines.slice(index + 1, close).join("\n"));
		index = close;
	}
	return blocks;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Runnable bash/eval tool code for `/copy cmd`, matching the TUI's copy target selection. */
export function copyCommandCode(name: string, args: unknown): string | null {
	if (!isRecord(args)) return null;
	if (name === "bash") return typeof args.command === "string" ? args.command : null;
	if (name !== "eval") return null;
	const cells = Array.isArray(args.cells) ? args.cells : typeof args.code === "string" ? [args] : null;
	if (cells === null) return null;
	const codeBlocks = cells.flatMap(cell => {
		if (!isRecord(cell) || typeof cell.code !== "string" || cell.code.length === 0) return [];
		return [cell.code];
	});
	return codeBlocks.length > 0 ? codeBlocks.join("\n\n") : null;
}
