import { describe, expect, it } from "bun:test";
import type { ReactElement, ReactNode } from "react";
import { Children, isValidElement } from "react";
import type { SessionSummary } from "@omp-console/protocol";
import type { CollabUiRequest } from "@oh-my-pi/pi-wire";
import { NeedsYouBar } from "../src/components/shell/NeedsYouBar";
import { AskForm } from "../src/components/shell/Composer";
import { stopTurn } from "../src/lib/away";
import { DeckApi, type FetchLike } from "../src/lib/api";
import { type OpenSessionView, selectNeedsYou } from "../src/lib/needs-you";

/** One tap target found in a rendered tree. */
interface Tap {
	label: string;
	fire(): void;
}

function textOf(node: ReactNode): string {
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(textOf).join("");
	if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
	return "";
}

/**
 * Walks a tree of hook-free function components and returns every element with an `onClick`: what a
 * finger can hit. Components that use hooks must not be passed in (they would throw).
 */
function taps(node: ReactNode): Tap[] {
	const found: Tap[] = [];
	const visit = (child: ReactNode): void => {
		if (Array.isArray(child)) return void child.forEach(visit);
		if (!isValidElement(child)) return;
		const element = child as ReactElement<Record<string, unknown>>;
		const { type, props } = element;
		if (typeof type === "function") return visit((type as (p: unknown) => ReactNode)(props));
		if (typeof props.onClick === "function") {
			found.push({ label: textOf(props.children as ReactNode).trim(), fire: () => (props.onClick as () => void)() });
		}
		Children.forEach(props.children as ReactNode, visit);
	};
	visit(node);
	return found;
}

function summary(id: string, extra: Partial<SessionSummary> = {}): SessionSummary {
	return {
		id,
		title: `title-${id}`,
		cwd: `/work/${id}`,
		state: "idle",
		createdAt: 1,
		lastActivityAt: 10,
		agentCount: 0,
		goalActive: false,
		awaitingAnswer: false,
		...extra,
	};
}

describe("away-mode tap counts (phone, session A open, session B waiting)", () => {
	const live = [summary("A", { state: "streaming" }), summary("B", { awaitingAnswer: true, state: "asking" })];

	/** Plays the flow: tap the bar row, then the answer. Returns the taps used and what was sent. */
	function answerFlow(ask: CollabUiRequest, option: string): { count: number; sent: Array<[number, string | undefined]> } {
		let count = 0;
		const sent: Array<[number, string | undefined]> = [];
		let open: OpenSessionView = { sessionId: "A", live: true, canAnswer: true, ask: null };

		const bar = taps(
			<NeedsYouBar
				items={selectNeedsYou(live, open)}
				onOpen={id => {
					// The switcher connects to B; once live, its guest reports the pending ask.
					open = { sessionId: id, live: true, canAnswer: true, ask };
				}}
			/>,
		);
		expect(bar).toHaveLength(1);
		bar[0]!.fire();
		count++;

		// B's composer now shows the ask form; the bar no longer repeats it.
		expect(selectNeedsYou(live, open)).toEqual([]);
		const form = taps(
			<AskForm request={ask} working={false} live onRespond={(reqId, value) => { sent.push([reqId, value]); }} onAbort={() => {}} />,
		);
		const answer = form.find(tap => tap.label.includes(option));
		expect(answer).toBeDefined();
		answer!.fire();
		count++;
		return { count, sent };
	}

	it("answers a single-choice ask in two taps", () => {
		const ask: CollabUiRequest = { reqId: 4, kind: "select", title: "Which branch?", options: ["main", "release"] };
		const { count, sent } = answerFlow(ask, "release");
		expect(count).toBe(2);
		expect(sent).toEqual([[4, "release"]]);
	});

	it("approves in two taps", () => {
		const ask: CollabUiRequest = {
			reqId: 9,
			kind: "select",
			title: "Run `bun test`?",
			options: [{ label: "Approve", description: "Run it once" }, "Deny"],
		};
		const { count, sent } = answerFlow(ask, "Approve");
		expect(count).toBe(2);
		expect(sent).toEqual([[9, "Approve"]]);
	});

	it("stops the running turn of the open session in one tap, next to the question when one is pending", () => {
		let aborted = 0;
		const ask: CollabUiRequest = { reqId: 1, kind: "select", title: "Continue?", options: ["Yes", "No"] };
		const form = taps(<AskForm request={ask} working live onRespond={() => {}} onAbort={() => aborted++} />);
		form.find(tap => tap.label === "Stop")!.fire();
		expect(aborted).toBe(1);
	});
});

function abortApi(response: Response | Error): DeckApi {
	const fetch: FetchLike = async () => {
		if (response instanceof Error) throw response;
		return response;
	};
	return new DeckApi({ fetch });
}

describe("stopTurn (one tap on a session row in the list)", () => {
	it("aborts through the control API with one request and no guest connection", async () => {
		const calls: Array<{ url: string; method: string | undefined; body: string | undefined }> = [];
		const api = new DeckApi({
			fetch: async (url, init) => {
				calls.push({
					url,
					method: init?.method,
					body: typeof init?.body === "string" ? init.body : undefined,
				});
				return new Response(JSON.stringify({ aborted: true }), {
					status: 202,
					headers: { "content-type": "application/json" },
				});
			},
		});
		expect(await stopTurn(api, "B")).toBe("aborted");
		expect(calls).toEqual([{ url: "/api/sessions/B/abort", method: "POST", body: undefined }]);
	});

	it("treats a 409 as an already-finished turn", async () => {
		expect(await stopTurn(abortApi(new Response("", { status: 409 })), "B")).toBe("idle");
	});

	it("maps a missing session and network failure to unavailable", async () => {
		expect(await stopTurn(abortApi(new Response("", { status: 404 })), "B")).toBe("unavailable");
		expect(await stopTurn(abortApi(new TypeError("fetch failed")), "B")).toBe("unavailable");
	});

	it("maps 401 and 403 to the not-authorized state", async () => {
		for (const status of [401, 403]) {
			expect(await stopTurn(abortApi(new Response("", { status })), "B")).toBe("not-authorized");
		}
	});
});
