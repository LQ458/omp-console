import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { makeTmp } from "./helpers";
import { PathSuggestionError, suggestPaths, workspaceSuggestions } from "../src/librarian/paths";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) {
		await fs.rm(directory, { recursive: true, force: true });
	}
});

function tempDirectory(prefix: string): string {
	const directory = makeTmp(prefix);
	temporaryDirectories.push(directory);
	return directory;
}

describe("zero-configuration new-session suggestions", () => {
	it("uses recent session working directories without configured project roots", async () => {
		const now = 1_800_000_000_000;
		const recent = await workspaceSuggestions(
			[
				{ cwd: "/work/alpha", lastActivityAt: now - 3_000 },
				{ cwd: "/work/alpha", lastActivityAt: now - 1_000 },
				{ cwd: "/work/beta", lastActivityAt: now - 500 },
				{ cwd: "/work/old", lastActivityAt: now - 31 * 24 * 60 * 60 * 1000 },
				{ cwd: "/work/deleted", lastActivityAt: now - 100, cwdExists: false },
			],
			{ projectRoots: [] },
			now,
		);

		expect(recent.map(({ cwd, sessions30d, lastUsedAt }) => ({ cwd, sessions30d, lastUsedAt }))).toEqual([
			{ cwd: "/work/beta", sessions30d: 1, lastUsedAt: now - 500 },
			{ cwd: "/work/alpha", sessions30d: 2, lastUsedAt: now - 1_000 },
		]);
	});

	it("lists only safe home children, then descends one level at the typed path", async () => {
		const home = tempDirectory("deck-path-home-");
		const directories = [
			"Projects",
			"Library",
			"Pictures",
			"Music",
			"Movies",
			"Mobile Documents",
			"node_modules",
			".git",
			".private",
		];
		for (const directory of directories) await fs.mkdir(path.join(home, directory), { recursive: true });
		const project = path.join(home, "Projects");
		const alpha = path.join(project, "alpha");
		const source = path.join(alpha, "src");
		await fs.mkdir(path.join(source, "deep"), { recursive: true });

		const untyped = await suggestPaths("", { projectRoots: [] }, home);
		expect(untyped.matches.map(match => match.path)).toEqual([project]);
		expect(untyped.matches.every(match => !match.path.startsWith(`${project}${path.sep}`))).toBe(true);

		const projectChildren = await suggestPaths("~/Projects/", { projectRoots: [] }, home);
		expect(projectChildren.typedPath).toBe(project);
		expect(projectChildren.matches.map(match => match.path)).toEqual([alpha]);

		const sourceChildren = await suggestPaths("~/Projects/alpha/", { projectRoots: [] }, home);
		expect(sourceChildren.matches.map(match => match.path)).toEqual([source]);
		expect(sourceChildren.matches).not.toContainEqual({ path: path.join(source, "deep"), exists: true });

		for (const heavy of directories.slice(1)) {
			const hidden = await suggestPaths(`~/${heavy}`, { projectRoots: [] }, home);
			expect(hidden.matches).toEqual([]);
			expect(hidden.typedPath).toBeUndefined();
		}
	});

	it("expands tilde paths and caps a home scan at 300 results", async () => {
		const home = tempDirectory("deck-path-wide-home-");
		for (let index = 0; index < 320; index++) {
			await fs.mkdir(path.join(home, `folder-${index}`));
		}
		const expandedHome = await suggestPaths("~", { projectRoots: [] }, home);
		const typedPath = await suggestPaths("~/folder-319", { projectRoots: [] }, home);
		const limited = await suggestPaths("", { projectRoots: [] }, home);

		expect(expandedHome.matches).toContainEqual({ path: home, exists: true });
		expect(typedPath.typedPath).toBe(path.join(home, "folder-319"));
		expect(typedPath.matches).toContainEqual({ path: path.join(home, "folder-319"), exists: true });
		expect(limited.matches).toHaveLength(300);
	});

	it("surfaces a directory scan error with the path it tried", async () => {
		const parent = tempDirectory("deck-path-not-directory-");
		const notDirectory = path.join(parent, "not-a-folder");
		await fs.writeFile(notDirectory, "file");

		let failure: unknown;
		try {
			await suggestPaths("", { projectRoots: [] }, notDirectory);
		} catch (error) {
			failure = error;
		}
		if (!(failure instanceof PathSuggestionError)) throw new Error("expected a path scan error");
		expect(failure.message).toContain(notDirectory);
	});
});

describe("home path suggestions follow real paths", () => {
	it("does not list a blocked folder reached through a symlink", async () => {
		const home = tempDirectory("deck-path-symlink-home-");
		const inner = path.join(home, "Library", "Mobile Documents", "com~apple~CloudDocs", "Inner");
		await fs.mkdir(inner, { recursive: true });
		await fs.symlink(path.join(home, "Library", "Mobile Documents"), path.join(home, "iCloud"));
		const result = await suggestPaths("~/iCloud/com~apple~CloudDocs/", { projectRoots: [] }, home);
		expect(result.matches.map(match => match.path)).toEqual([]);
	});
});
