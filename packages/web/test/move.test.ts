import { describe, expect, it } from "bun:test";
import type { MoveConfirmRequest, MovePrepareRequest, MovePreview, MoveRecord } from "@omp-console/protocol";
import { DeckApiError } from "../src/lib/api";
import {
	canUndo,
	MoveFlow,
	type MoveApi,
	type MoveState,
	type NativeInvoke,
	nativeInvoke,
	slugify,
	undoMove,
	validateSlug,
} from "../src/lib/move";

const PREVIEW: MovePreview = {
	id: "mv1",
	destination: "/Users/dev/Documents/GitHub/new-tool",
	files: 12,
	bytes: 2_048,
	excluded: [{ path: ".env", reason: "secret" }],
	nonce: "n0nce",
	expiresAt: 10_000,
};

const RECORD: MoveRecord = {
	id: "mv1",
	sourceSessionId: "s1",
	sourceRoot: "/Users/alice/Knowledge/new-tool",
	destination: PREVIEW.destination,
	at: 5,
	state: "done",
};

interface Harness {
	flow: MoveFlow;
	prepares: MovePrepareRequest[];
	confirms: Array<{ id: string; body: MoveConfirmRequest }>;
	invocations: Array<{ command: string; args: Record<string, unknown> }>;
	done: MoveRecord[];
	clock: { now: number };
}

type Bridge = (calls: Array<{ command: string; args: Record<string, unknown> }>) => NativeInvoke;

/** A native bridge that records each call and answers with `answer`. */
const bridge =
	(answer: NativeInvoke): Bridge =>
	calls =>
	async (command, args) => {
		calls.push({ command, args });
		return answer(command, args);
	};

function harness(options: {
	invoke: Bridge | null;
	confirm?: () => Promise<MoveRecord>;
	preview?: MovePreview;
}): Harness {
	const prepares: MovePrepareRequest[] = [];
	const confirms: Harness["confirms"] = [];
	const invocations: Harness["invocations"] = [];
	const done: MoveRecord[] = [];
	const clock = { now: 1_000 };
	const api: MoveApi = {
		async prepareMove(request) {
			prepares.push(request);
			return options.preview ?? PREVIEW;
		},
		async confirmMove(id, body) {
			confirms.push({ id, body });
			return options.confirm ? options.confirm() : RECORD;
		},
	};
	const invoke = options.invoke === null ? null : options.invoke(invocations);
	const flow = new MoveFlow({ api, invoke: () => invoke, now: () => clock.now, onDone: r => done.push(r) });
	return { flow, prepares, confirms, invocations, done, clock };
}

const approve = (token: string): Bridge => bridge(async () => token);

const phase = (h: Harness): MoveState["phase"] => h.flow.getState().phase;

describe("MoveFlow", () => {
	it("outside the Mac app it stops at 'confirm on the Mac' and never calls the daemon's confirm", async () => {
		const h = harness({ invoke: null });
		await h.flow.prepare({ id: "sg1" }, "new-tool");
		expect(phase(h)).toBe("needs-mac");
		await h.flow.confirm();
		await h.flow.confirm();
		expect(phase(h)).toBe("needs-mac");
		expect(h.confirms).toEqual([]);
		expect(h.done).toEqual([]);
	});

	it("asks the native app with the daemon's facts, then sends exactly that token to the daemon", async () => {
		const h = harness({ invoke: approve("signed-token") });
		await h.flow.prepare({ id: "sg1" }, "new-tool");
		expect(h.prepares).toEqual([{ suggestionId: "sg1", slug: "new-tool" }]);
		expect(phase(h)).toBe("preview");
		await h.flow.confirm();
		expect(h.invocations).toEqual([
			{
				command: "confirm_move",
				args: { moveId: "mv1", nonce: "n0nce" },
			},
		]);
		expect(h.confirms).toEqual([{ id: "mv1", body: { nonce: "n0nce", token: "signed-token" } }]);
		expect(h.flow.getState()).toEqual({ phase: "done", record: RECORD });
		expect(h.done).toEqual([RECORD]);
	});

	it("returns to the preview without touching the daemon when the Mac dialog is declined", async () => {
		const h = harness({
			invoke: () => async () => {
				throw new Error("user declined");
			},
		});
		await h.flow.prepare({ id: "sg1" }, "new-tool");
		await h.flow.confirm();
		expect(h.flow.getState()).toMatchObject({ phase: "preview", note: expect.stringContaining("Nothing was copied") });
		expect(h.confirms).toEqual([]);
	});

	it("ignores an approval that arrives after the user cancelled", async () => {
		const gate = Promise.withResolvers<string>();
		const h = harness({ invoke: () => () => gate.promise });
		await h.flow.prepare({ id: "sg1" }, "new-tool");
		const pending = h.flow.confirm();
		expect(phase(h)).toBe("confirming");
		h.flow.cancel();
		gate.resolve("late-token");
		await pending;
		expect(phase(h)).toBe("idle");
		expect(h.confirms).toEqual([]);
	});

	it("does not open a second native dialog for a double click", async () => {
		const gate = Promise.withResolvers<string>();
		const h = harness({ invoke: calls => async (command, args) => {
			calls.push({ command, args });
			return gate.promise;
		} });
		await h.flow.prepare({ id: "sg1" }, "new-tool");
		const first = h.flow.confirm();
		await h.flow.confirm();
		gate.resolve("t");
		await first;
		expect(h.invocations).toHaveLength(1);
		expect(h.confirms).toHaveLength(1);
	});

	it("refuses an expired preview before the dialog, and an approval that outlives the preview", async () => {
		const early = harness({ invoke: approve("t") });
		await early.flow.prepare({ id: "sg1" }, "new-tool");
		early.clock.now = PREVIEW.expiresAt;
		await early.flow.confirm();
		expect(phase(early)).toBe("expired");
		expect(early.invocations).toEqual([]);

		const gate = Promise.withResolvers<string>();
		const late = harness({ invoke: () => () => gate.promise });
		await late.flow.prepare({ id: "sg1" }, "new-tool");
		const pending = late.flow.confirm();
		late.clock.now = PREVIEW.expiresAt + 1;
		gate.resolve("t");
		await pending;
		expect(phase(late)).toBe("expired");
		expect(late.confirms).toEqual([]);
	});

	it("explains a daemon 403 as 'not accepted' and keeps the failure visible", async () => {
		const h = harness({
			invoke: approve("forged"),
			confirm: () => Promise.reject(new DeckApiError("auth", 403, "forbidden")),
		});
		await h.flow.prepare({ id: "sg1" }, "new-tool");
		await h.flow.confirm();
		expect(h.flow.getState()).toMatchObject({ phase: "failed", message: expect.stringContaining("did not accept") });
		expect(h.done).toEqual([]);
	});

	it("rejects an invalid slug locally and calls no endpoint", async () => {
		const h = harness({ invoke: approve("t") });
		await h.flow.prepare({ id: "sg1" }, "../etc");
		expect(phase(h)).toBe("failed");
		expect(h.prepares).toEqual([]);
	});

	it("notifies subscribers on every transition, in order", async () => {
		const h = harness({ invoke: approve("t") });
		const seen: string[] = [];
		h.flow.subscribe(() => seen.push(phase(h)));
		await h.flow.prepare({ id: "sg1" }, "new-tool");
		await h.flow.confirm();
		expect(seen).toEqual(["preparing", "preview", "confirming", "done"]);
	});
});

describe("slugs and the native bridge", () => {
	it("accepts only [a-z0-9] words joined by single hyphens", () => {
		for (const ok of ["a", "new-tool", "x1-y2-z3"]) expect(validateSlug(ok).ok).toBe(true);
		for (const bad of ["", "New", "a_b", "a--b", "-a", "a-", "a b", "tооl" /* cyrillic o */, "../x", "a/b", "x".repeat(49)]) {
			expect(validateSlug(bad).ok).toBe(false);
		}
	});

	it("slugify output always validates, and drops lookalike letters instead of keeping them", () => {
		for (const text of ["My New Tool!", "  --  ", "tооl", "Ünïcode name", "a".repeat(80)]) {
			const slug = slugify(text);
			expect(slug === "" || validateSlug(slug).ok).toBe(true);
		}
		expect(slugify("My New Tool!")).toBe("my-new-tool");
	});

	it("finds the Tauri invoke in the global API and in the internals, and nowhere else", () => {
		const invoke: NativeInvoke = async () => "t";
		expect(nativeInvoke({ __TAURI__: { core: { invoke } } })).toBe(invoke);
		expect(nativeInvoke({ __TAURI_INTERNALS__: { invoke } })).toBe(invoke);
		expect(nativeInvoke({ __TAURI__: {} })).toBeNull();
		expect(nativeInvoke({})).toBeNull();
	});
});

describe("undoMove", () => {
	it("turns the daemon's 409 into a plain refusal and lets only copied moves be undone", async () => {
		const refused = await undoMove({ undoMove: () => Promise.reject(new DeckApiError("conflict", 409, "changed")) }, "mv1");
		expect(refused).toEqual({ ok: false, message: expect.stringContaining("Undo refused") });
		expect(await undoMove({ undoMove: async () => {} }, "mv1")).toEqual({ ok: true });
		expect(canUndo(RECORD)).toBe(true);
		for (const state of ["prepared", "undone", "failed"] as const) expect(canUndo({ ...RECORD, state })).toBe(false);
	});
});
