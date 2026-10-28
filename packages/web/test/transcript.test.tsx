import { describe, expect, it } from "bun:test";
import type { AssistantMessage, SessionEntry } from "@oh-my-pi/pi-wire";
import { renderToStaticMarkup } from "react-dom/server";
import "./transcript-dom-shim";
import {
	followTranscriptTail,
	Transcript,
	updateTranscriptTailLock,
} from "../src/components/transcript/Transcript";
import type { ActiveTool } from "../src/lib/client";

const TOOL_CALL_ID = "call-running-tool";
const TOOL_NAME = "probe_tool";

const RAW_ASSISTANT_TARGET = "stale-raw-assistant-target";
const ACTIVE_TOOL_TARGET = "effective-active-tool-target";

function assistantUsage(): AssistantMessage["usage"] {
	return { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0 } };
}

function committedAssistantToolCall(): SessionEntry {
	return {
		type: "message",
		id: "assistant-entry-1",
		parentId: null,
		timestamp: "2026-07-09T00:00:00Z",
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "I will run the tool." },
				{
					type: "toolCall",
					id: TOOL_CALL_ID,
					name: TOOL_NAME,
					arguments: { target: RAW_ASSISTANT_TARGET },
					intent: "Inspect fixture input",
				},
			],
			model: "test/model",
			usage: assistantUsage(),
			stopReason: "stop",
			timestamp: 1,
		},
	};
}

function activeTool(): ActiveTool {
	return {
		toolCallId: TOOL_CALL_ID,
		toolName: TOOL_NAME,
		args: { target: ACTIVE_TOOL_TARGET },
		intent: "Inspect fixture input",
		startedAt: 1,
	};
}

function renderTranscript(props: {
	entries?: readonly SessionEntry[];
	activeTools?: ReadonlyMap<string, ActiveTool>;
	working: boolean;
}): string {
	return renderToStaticMarkup(
		<Transcript
			entries={props.entries ?? []}
			stream={null}
			streamDone={true}
			activeTools={props.activeTools ?? new Map()}
			working={props.working}
		/>,
	);
}

function countElements(html: string, selector: string): number {
	let count = 0;
	new HTMLRewriter()
		.on(selector, {
			element() {
				count++;
			},
		})
		.transform(html);
	return count;
}

function countOccurrences(text: string, needle: string): number {
	let count = 0;
	let start = 0;
	while (true) {
		const index = text.indexOf(needle, start);
		if (index === -1) return count;
		count++;
		start = index + needle.length;
	}
}

describe("Transcript live tool rendering", () => {
	it("renders one running card for a committed tool call using active args without the working shimmer", () => {
		const html = renderTranscript({
			entries: [committedAssistantToolCall()],
			activeTools: new Map([[TOOL_CALL_ID, activeTool()]]),
			working: true,
		});

		expect(countElements(html, ".tv-card")).toBe(1);
		expect(countElements(html, '[aria-label="running"]')).toBe(1);
		expect(countOccurrences(html, TOOL_NAME)).toBe(1);
		expect(html).not.toContain("thinking…");
		expect(html).toContain(ACTIVE_TOOL_TARGET);
		expect(html).not.toContain(RAW_ASSISTANT_TARGET);
	});

	it("keeps the working shimmer when no tool is active", () => {
		const html = renderTranscript({ working: true, activeTools: new Map() });

		expect(html).toContain("thinking…");
	});
});

describe("Transcript message Markdown", () => {
	it("renders host strings and guest text blocks as Markdown", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "host-markdown",
				parentId: null,
				timestamp: "2026-07-15T00:00:00Z",
				message: {
					role: "user",
					content: "Use `381866285601915778`",
					timestamp: 1,
				},
			},
			{
				type: "custom_message",
				id: "guest-markdown",
				parentId: "host-markdown",
				timestamp: "2026-07-15T00:00:01Z",
				customType: "collab-prompt",
				content: [{ type: "text", text: "Guest uses **Markdown**" }],
				details: { from: "guest" },
				display: true,
			},
		];

		const html = renderTranscript({ entries, working: false });

		expect(countElements(html, ".tr-row--user .tr-md code")).toBe(1);
		expect(countElements(html, ".tr-row--user .tr-md strong")).toBe(1);
	});

	it("renders copy controls for message prose and opens the latest safe HTTP link", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "linked-user",
				parentId: null,
				timestamp: "2026-07-15T00:00:00Z",
				message: { role: "user", content: "See https://docs.example.test/guide.", timestamp: 1 },
			},
		];
		const html = renderTranscript({ entries, working: false });
		expect(countElements(html, ".tr-copy")).toBe(1);
		expect(html).toContain('aria-label="Open last link"');
	});
});

describe("Transcript tail-follow scroll operations", () => {
	it("restores tail-follow when a connection becomes live", () => {
		const element = { scrollTop: 0, scrollHeight: 1_000, clientHeight: 200 };
		const lock = { current: false };

		followTranscriptTail(element, lock, true);
		expect(lock.current).toBe(true);
		expect(element.scrollTop).toBe(1_000);

		element.scrollTop = 600;
		updateTranscriptTailLock(element, lock);
		expect(lock.current).toBe(false);

		element.scrollHeight = 1_200;
		followTranscriptTail(element, lock);
		expect(element.scrollTop).toBe(600);

		followTranscriptTail(element, lock, true);
		expect(lock.current).toBe(true);
		expect(element.scrollTop).toBe(1_200);
	});
});

describe("Transcript windowing", () => {
	const users = (count: number): SessionEntry[] =>
		Array.from({ length: count }, (_, i) => ({
			type: "message",
			id: `m${i}`,
			parentId: i === 0 ? null : `m${i - 1}`,
			timestamp: "2026-07-15T00:00:00Z",
			message: { role: "user", content: `message-${i}-end`, timestamp: i },
		}));

	it("mounts a bounded window at the tail of a long transcript and reserves the rest as spacer", () => {
		const html = renderTranscript({ entries: users(5_000), working: false });

		const mounted = countElements(html, ".tr-vrow");
		expect(mounted).toBeGreaterThan(0);
		expect(mounted).toBeLessThan(60);
		expect(html).toContain("message-4999-end");
		expect(html).not.toContain("message-0-end");
		// the first mounted row's position tells assistive tech where it sits among all 5000
		expect(html).toContain(`aria-posinset="${5_000 - mounted + 1}"`);
		expect(html).toContain('aria-setsize="5000"');
		const spacer = /class="tr-list" style="padding-top:(\d+(?:\.\d+)?)px/.exec(html);
		expect(Number(spacer?.[1])).toBeGreaterThan(100_000);
	});

	it("gives hidden entries and tool results no row, so they take no estimated height", () => {
		const entries: SessionEntry[] = [
			...users(1),
			{
				type: "message",
				id: "result",
				parentId: "m0",
				timestamp: "2026-07-15T00:00:00Z",
				message: {
					role: "toolResult",
					toolCallId: "c1",
					toolName: "bash",
					content: [{ type: "text", text: "out" }],
					isError: false,
					timestamp: 1,
				},
			},
			{
				type: "custom_message",
				id: "hidden",
				parentId: "result",
				timestamp: "2026-07-15T00:00:00Z",
				customType: "internal",
				content: "secret",
				details: null,
				display: false,
			},
		];

		const html = renderTranscript({ entries, working: false });

		expect(countElements(html, ".tr-vrow")).toBe(1);
		expect(html).toContain('aria-setsize="1"');
	});
});

describe("Transcript background job notices", () => {
	it("shows a finished subagent as one collapsed line, never the raw system-notice or task-result tags", () => {
		const entries: SessionEntry[] = [
			{
				type: "custom_message",
				id: "async",
				parentId: null,
				timestamp: "2026-10-24T00:00:00Z",
				customType: "async-result",
				content:
					'<system-notice>\nBackground job NewDeployAndMonitor has completed. Resume your work using the result below.\n<task-result agent="NewDeployAndMonitor">\n<output>\nREADME workflow verified.\n</output>\n</task-result>\nNewDeployAndMonitor is now idle.\n</system-notice>',
				details: null,
				display: true,
			},
		];

		const html = renderTranscript({ entries, working: false });

		expect(html).toContain("Background job NewDeployAndMonitor finished");
		expect(html).not.toContain("system-notice");
		expect(html).not.toContain("task-result");
		// Collapsed: the result body only renders once opened.
		expect(html).not.toContain("README workflow verified.");
	});
});
