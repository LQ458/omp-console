import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ArchiveStore, type ArchiveRecord } from "../src/archive";
import { excludeArchivedLibrarianRows } from "../src/librarian/archive-filter";
import { makeTmp } from "./helpers";

describe("ArchiveStore", () => {
	it("persists metadata across store instances and restores without touching session files", async () => {
		const stateDir = makeTmp("deck-archive-store-");
		const sessionFile = path.join(makeTmp("deck-archive-session-"), "session.jsonl");
		fs.writeFileSync(sessionFile, "session bytes\n");
		const before = fs.readFileSync(sessionFile);
		const record: ArchiveRecord = {
			archivedAt: 123,
			title: "Saved work",
			cwd: "/work/project",
			sessionFile,
			lastActivityAt: 100,
		};

		const first = await ArchiveStore.open(stateDir);
		expect(first.isArchived("saved")).toBe(false);
		await first.archive("saved", record);
		if (process.platform !== "win32") expect(fs.statSync(path.join(stateDir, "archived-sessions.json")).mode & 0o777).toBe(0o600);

		const reopened = await ArchiveStore.open(stateDir);
		expect(reopened.get("saved")).toEqual(record);
		expect(await reopened.restore("saved")).toBe(true);
		expect((await ArchiveStore.open(stateDir)).isArchived("saved")).toBe(false);
		expect(fs.readFileSync(sessionFile)).toEqual(before);
	});

	it("preserves a corrupt state file and starts empty with one diagnostic", async () => {
		const stateDir = makeTmp("deck-archive-corrupt-");
		const file = path.join(stateDir, "archived-sessions.json");
		const corrupt = "{not valid json\n";
		fs.writeFileSync(file, corrupt);
		const messages: string[] = [];

		const store = await ArchiveStore.open(stateDir, message => messages.push(message));

		expect(store.list()).toEqual([]);
		const preserved = fs.readdirSync(stateDir).filter(name => name.startsWith("archived-sessions.json.corrupt-"));
		expect(preserved).toHaveLength(1);
		expect(fs.readFileSync(path.join(stateDir, preserved[0]!), "utf8")).toBe(corrupt);
		expect(messages).toHaveLength(1);
	});
});

describe("archived librarian rows", () => {
	it("excludes archived session ids from cards and the away brief while preserving other response fields", async () => {
		const isArchived = (id: string): boolean => id === "archived";
		const cards = await excludeArchivedLibrarianRows(
			new Response(JSON.stringify({ cards: [{ sessionId: "archived" }, { sessionId: "active" }], topics: ["work"] })),
			"/api/cards",
			isArchived,
		);
		expect(await cards.json()).toEqual({ cards: [{ sessionId: "active" }], topics: ["work"] });

		const brief = await excludeArchivedLibrarianRows(
			new Response(JSON.stringify({ lines: [{ sessionId: "archived" }, { sessionId: "active" }], generatedAt: 1 })),
			"/api/brief",
			isArchived,
		);
		expect(await brief.json()).toEqual({ lines: [{ sessionId: "active" }], generatedAt: 1 });
	});
});
