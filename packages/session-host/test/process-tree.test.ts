import { describe, expect, test } from "bun:test";
import { descendantPids } from "../src/process-tree";

describe("descendantPids", () => {
	test("lists each descendant once, deepest first, even when a snapshot contains a cycle", () => {
		// 100 -> 200 -> 300, and 300 is recorded as the parent of 200's parent (a reused Windows pid), closing a cycle;
		// pid 0 lists itself as its own parent as Windows' idle process does.
		const parents = new Map<number, number>([
			[200, 100],
			[300, 200],
			[100, 300],
			[0, 0],
			[400, 1],
		]);
		expect(descendantPids(100, parents)).toEqual([300, 200]);
		expect(descendantPids(0, parents)).toEqual([]);
	});
});
