import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { GuestClient } from "../src/lib/client";
import { encodeBase64Url } from "../src/lib/link";
import {
	hostQueueChips,
	mapQueueChips,
	QueueChips,
	QueueTracker,
	queueTracker,
} from "../src/components/shell/QueueChips";

const LINK = `roomroomroom1234#${encodeBase64Url(new Uint8Array(32))}`;

describe("hostQueueChips", () => {
	it("skips live-steered entries and indexes steering before follow-ups, as remove_queued_message does", () => {
		expect(hostQueueChips({ steering: ["live", "s1"], followUp: ["f1"], liveSteered: 1 })).toEqual([
			{ index: 0, text: "s1" },
			{ index: 1, text: "f1" },
		]);
		expect(hostQueueChips({ steering: ["live"], followUp: [], liveSteered: 1 })).toEqual([]);
	});
});

describe("mapQueueChips", () => {
	it("gives the host's newest entries the texts this omp console sent and the older ones a generic chip", () => {
		expect(mapQueueChips(3, ["b", "c"])).toEqual([
			{ index: 0, text: null },
			{ index: 1, text: "b" },
			{ index: 2, text: "c" },
		]);
	});

	it("never shows more chips than the host's count, keeping the newest texts", () => {
		expect(mapQueueChips(1, ["a", "b", "c"])).toEqual([{ index: 0, text: "c" }]);
		expect(mapQueueChips(0, ["a"])).toEqual([]);
		expect(mapQueueChips(2, [])).toEqual([
			{ index: 0, text: null },
			{ index: 1, text: null },
		]);
	});
});

describe("QueueTracker", () => {
	it("forgets the oldest texts as the host's count drops, because the host runs its queue in order", () => {
		const tracker = new QueueTracker();
		tracker.reconcile(0);
		tracker.record("one");
		tracker.record("two");
		tracker.reconcile(2);
		expect(tracker.getSnapshot()).toEqual(["one", "two"]);
		tracker.reconcile(1); // "one" ran
		expect(tracker.getSnapshot()).toEqual(["two"]);
		tracker.reconcile(0);
		expect(tracker.getSnapshot()).toEqual([]);
	});

	it("does not drop a text recorded before the host's count caught up", () => {
		const tracker = new QueueTracker();
		tracker.reconcile(0);
		tracker.record("sent just now");
		tracker.reconcile(0); // a render before the state frame arrives
		expect(tracker.getSnapshot()).toEqual(["sent just now"]);
		tracker.reconcile(1);
		expect(tracker.getSnapshot()).toEqual(["sent just now"]);
	});

	it("forgets a text whose prompt never reached the host's queue once the count stays zero past the lag window", () => {
		const tracker = new QueueTracker();
		tracker.record("dropped before queueing", 1_000);
		tracker.reconcile(0, 1_000 + 4_999);
		expect(tracker.getSnapshot()).toEqual(["dropped before queueing"]);
		tracker.reconcile(0, 1_000 + 5_001);
		expect(tracker.getSnapshot()).toEqual([]);
	});

	it("counts entries queued elsewhere as running first", () => {
		const tracker = new QueueTracker();
		tracker.reconcile(2); // two entries from the terminal
		tracker.record("mine");
		tracker.reconcile(3);
		tracker.reconcile(2); // one terminal entry ran; mine is still waiting
		expect(tracker.getSnapshot()).toEqual(["mine"]);
		tracker.reconcile(1); // the other terminal entry ran
		expect(tracker.getSnapshot()).toEqual(["mine"]);
		tracker.reconcile(0);
		expect(tracker.getSnapshot()).toEqual([]);
	});

	it("drops exactly the removed entry, by its position in the host's queue", () => {
		const tracker = new QueueTracker();
		tracker.reconcile(1);
		tracker.record("a");
		tracker.record("b");
		tracker.record("c");
		tracker.reconcile(4); // one entry from elsewhere is first
		tracker.removed(2, 4); // "b"
		expect(tracker.getSnapshot()).toEqual(["a", "c"]);
		tracker.removed(0, 3); // the generic one: no text to drop
		expect(tracker.getSnapshot()).toEqual(["a", "c"]);
	});

	it("keeps one tracker per connection", () => {
		const a = new GuestClient(LINK, "a");
		const b = new GuestClient(LINK, "b");
		expect(queueTracker(a)).toBe(queueTracker(a));
		expect(queueTracker(a)).not.toBe(queueTracker(b));
	});
});

describe("QueueChips", () => {
	const api = { sessionOp: async () => ({ ok: true as const }) };

	it("renders one chip per queued entry with the remembered text and a remove button", () => {
		const client = new GuestClient(LINK, "tester");
		queueTracker(client).record("fix the flaky test");
		const html = renderToStaticMarkup(<QueueChips client={client} count={2} readOnly={false} api={api} sessionId="s1" />);
		expect(html).toContain("fix the flaky test");
		expect(html).toContain("queued message");
		expect(html.match(/qc-remove/g)).toHaveLength(2);
		expect(html).toContain('aria-label="2 queued messages"');
	});

	it("renders nothing when the host's queue is empty", () => {
		const client = new GuestClient(LINK, "tester");
		queueTracker(client).record("stale");
		expect(renderToStaticMarkup(<QueueChips client={client} count={0} readOnly={false} api={api} sessionId="s1" />)).toBe("");
	});

	it("offers no remove button to a read-only guest or without the daemon API", () => {
		const client = new GuestClient(LINK, "tester");
		const readOnly = renderToStaticMarkup(<QueueChips client={client} count={1} readOnly api={api} sessionId="s1" />);
		const noApi = renderToStaticMarkup(<QueueChips client={client} count={1} readOnly={false} />);
		expect(readOnly).toContain("qc-chip");
		expect(readOnly).not.toContain("qc-remove");
		expect(noApi).toContain("qc-chip");
		expect(noApi).not.toContain("qc-remove");
	});
});
