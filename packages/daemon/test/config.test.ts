import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DaemonConfigError, loadDaemonConfigFile, parseDaemonConfigFile } from "../src/config";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function tempDir(): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omp-console-config-"));
	directories.push(directory);
	return directory;
}

describe("daemon config file", () => {
	it("parses typed feature flags, resolves paths relative to state, and deduplicates allowed sources", () => {
		const stateDir = "/state/config";
		const parsed = parseDaemonConfigFile(
			{
				features: { librarian: true, agenda: true, quickAsk: true, peers: true, openrouterDecisions: true, computerUse: true, overnight: true },
				quickAsk: { sources: ["repo", "siyuan", "repo"] },
				knowledgeRoot: "Knowledge",
				projectRoots: ["Projects"],
				scheduleFile: "schedule.toml",
				agendaHub: "tasks-hub",
				peers: [{ id: "remote", url: "https://example.com:8443/path" }],
			},
			stateDir,
		);

		expect(parsed).toEqual({
			features: { librarian: true, agenda: true, quickAsk: true, peers: true, openrouterDecisions: true, computerUse: true, overnight: true },
			quickAsk: { sources: ["repo", "siyuan"] },
			knowledgeRoot: path.resolve(stateDir, "Knowledge"),
			projectRoots: [path.resolve(stateDir, "Projects")],
			scheduleFile: path.resolve(stateDir, "schedule.toml"),
			agendaHub: path.resolve(stateDir, "tasks-hub"),
			peers: [{ id: "remote", name: "REMOTE", url: "https://example.com:8443" }],
		});
	});

	it("returns empty defaults when the optional file is absent and reads a valid file", async () => {
		const stateDir = tempDir();
		expect(await loadDaemonConfigFile(stateDir)).toEqual({});
		fs.writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({ features: { agenda: false }, quickAsk: { sources: [] } }));
		expect(await loadDaemonConfigFile(stateDir)).toEqual({ features: { agenda: false }, quickAsk: { sources: [] } });
	});

	it("rejects invalid shapes, unknown fields, source ids, peer URLs, and duplicate peer ids", () => {
		const invalid: unknown[] = [
			[],
			{ unknown: true },
			{ features: [] },
			{ features: { unknown: true } },
			{ features: { librarian: "yes" } },
			{ quickAsk: { sources: "repo" } },
			{ quickAsk: { sources: ["not-a-source"] } },
			{ knowledgeRoot: "  " },
			{ projectRoots: [1] },
			{ scheduleFile: false },
			{ agendaHub: "" },
			{ peers: [{ id: "bad id", url: "https://example.com" }] },
			{ peers: [{ id: "remote", url: "http://example.com" }] },
			{ peers: [{ id: "remote", url: "https://example.com" }, { id: "remote", url: "https://other.example" }] },
		];
		for (const value of invalid) expect(() => parseDaemonConfigFile(value, "/state")).toThrow(DaemonConfigError);
	});

	it("reports invalid JSON and identifies the config file", async () => {
		const stateDir = tempDir();
		fs.writeFileSync(path.join(stateDir, "config.json"), "{not json");
		await expect(loadDaemonConfigFile(stateDir)).rejects.toThrow("config.json: invalid JSON");
	});
});
