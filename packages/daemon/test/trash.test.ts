import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { moveSessionToTrash } from "../src/trash";
import { makeTmp } from "./helpers";

const now = () => new Date(2026, 9, 25, 16, 30, 5);

function session(dir: string, name: string, withFolder = false): string {
	const file = path.join(dir, name);
	fs.writeFileSync(file, `${name}\n`);
	if (withFolder) {
		fs.mkdirSync(file.slice(0, -".jsonl".length));
		fs.writeFileSync(path.join(file.slice(0, -".jsonl".length), "Sub.jsonl"), "sub\n");
	}
	return file;
}

describe("moveSessionToTrash", () => {
	it("keeps a transcript and its subagent folder together in one Trash folder, never reusing an earlier one", async () => {
		const trash = makeTmp("deck-trash-");
		const first = await moveSessionToTrash(session(makeTmp("deck-store-"), "a.jsonl", true), { stateDir: makeTmp(), systemTrashDir: trash, now });
		const second = await moveSessionToTrash(session(makeTmp("deck-store-"), "a.jsonl"), { stateDir: makeTmp(), systemTrashDir: trash, now });

		expect(first).toBe(path.join(trash, "omp-console session 20261025-163005 a"));
		expect(second).toBe(path.join(trash, "omp-console session 20261025-163005 a-2"));
		expect(fs.readFileSync(path.join(first, "a", "Sub.jsonl"), "utf8")).toBe("sub\n");
		expect(fs.readFileSync(path.join(first, "a.jsonl"), "utf8")).toBe("a.jsonl\n");
		expect(fs.readFileSync(path.join(second, "a.jsonl"), "utf8")).toBe("a.jsonl\n");
	});

	it("falls back to the daemon's own trash folder when the system Trash refuses, leaving nothing behind there", async () => {
		const store = makeTmp("deck-store-");
		const stateDir = makeTmp("deck-state-");
		const blocked = path.join(makeTmp(), "not-a-dir");
		fs.writeFileSync(blocked, "file, not a folder");
		const file = session(store, "b.jsonl", true);

		const target = await moveSessionToTrash(file, { stateDir, systemTrashDir: blocked, now });
		expect(target).toBe(path.join(stateDir, "trash", "20261025-163005-b"));
		expect(fs.existsSync(path.join(target, "b.jsonl"))).toBe(true);
		expect(fs.existsSync(path.join(target, "b", "Sub.jsonl"))).toBe(true);
		expect(fs.readdirSync(store)).toEqual([]);
	});

	it("keeps the session and sibling folder together when the state-dir Trash is on another volume", async () => {
		const store = makeTmp("deck-cross-volume-store-");
		const stateDir = makeTmp("deck-cross-volume-state-");
		const file = session(store, "cross-volume.jsonl", true);
		const ownTrash = path.join(stateDir, "trash");
		const target = await moveSessionToTrash(file, {
			stateDir,
			systemTrashDir: null,
			now,
			rename: async (source, destination) => {
				if (destination.startsWith(`${ownTrash}${path.sep}`)) throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
				await fs.promises.rename(source, destination);
			},
		});

		expect(target).toBe(path.join(store, ".omp-console-trash", "20261025-163005-cross-volume"));
		expect(fs.readFileSync(path.join(target, "cross-volume.jsonl"), "utf8")).toBe("cross-volume.jsonl\n");
		expect(fs.readFileSync(path.join(target, "cross-volume", "Sub.jsonl"), "utf8")).toBe("sub\n");
		expect(fs.existsSync(file)).toBe(false);
		expect(fs.existsSync(path.join(store, "cross-volume"))).toBe(false);
	});
});
