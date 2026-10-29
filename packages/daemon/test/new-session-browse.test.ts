import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { browseNewSessionDirectory, NewSessionBrowseError } from "../src/new-session-browse";
import { isPathWithin } from "../src/librarian/paths";
import { makeTmp } from "./helpers";
import { startTestDaemon, stopTestDaemons } from "./harness";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await stopTestDaemons();
	for (const directory of temporaryDirectories.splice(0)) {
		await fs.rm(directory, { recursive: true, force: true });
	}
});

function tempDirectory(prefix: string): string {
	const directory = makeTmp(prefix);
	temporaryDirectories.push(directory);
	return directory;
}

async function expectBrowseError(promise: Promise<unknown>, status: number): Promise<NewSessionBrowseError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof NewSessionBrowseError && error.status === status) return error;
		throw error;
	}
	throw new Error(`expected folder browse to fail with HTTP ${status}`);
}

describe("new-session folder browsing", () => {
	it("lists safe child folders in case-insensitive order and returns the parent", async () => {
		const home = tempDirectory("deck-browse-home-");
		for (const name of ["zeta", "Beta", "alpha", ".private", "node_modules", "Library"]) {
			await fs.mkdir(path.join(home, name));
		}
		await fs.writeFile(path.join(home, "notes.txt"), "not a folder");
		const projects = path.join(home, "projects");
		const app = path.join(projects, "app");
		await fs.mkdir(app, { recursive: true });

		const root = await browseNewSessionDirectory(undefined, { homeDirectory: home });
		const nested = await browseNewSessionDirectory(app, { homeDirectory: home });
		const realHome = await fs.realpath(home);
		const realProjects = await fs.realpath(projects);

		expect(root.entries.map(entry => entry.name)).toEqual(["alpha", "Beta", "projects", "zeta"]);
		expect(root).toMatchObject({ dir: realHome, home: realHome, truncated: false });
		expect(root.parent).toBeUndefined();
		expect(nested.entries).toEqual([]);
		expect(nested.parent).toBe(realProjects);
	});

	it.skipIf(process.platform === "win32")("lists safe directory links but never exposes a symlink that leaves home", async () => {
		const home = tempDirectory("deck-browse-link-home-");
		const outside = tempDirectory("deck-browse-link-outside-");
		const insideTarget = path.join(home, "code");
		await fs.mkdir(insideTarget);
		await fs.mkdir(path.join(outside, "secret"));
		await fs.symlink(insideTarget, path.join(home, "code-link"));
		await fs.symlink(outside, path.join(home, "escape"));

		const result = await browseNewSessionDirectory(home, { homeDirectory: home });

		expect(result.entries.map(entry => entry.name)).toEqual(["code", "code-link"]);
		await expectBrowseError(browseNewSessionDirectory(path.join(home, "escape"), { homeDirectory: home }), 403);
	});

	it("allows an explicitly configured project root outside home but not its sibling", async () => {
		const home = tempDirectory("deck-browse-root-home-");
		const configured = tempDirectory("deck-browse-projects-");
		const app = path.join(configured, "app");
		await fs.mkdir(app);
		const result = await browseNewSessionDirectory(app, { homeDirectory: home, projectRoots: [configured] });
		const realApp = await fs.realpath(app);
		const realConfigured = await fs.realpath(configured);

		expect(result.dir).toBe(realApp);
		expect(result.parent).toBe(realConfigured);
		await expectBrowseError(
			browseNewSessionDirectory(path.dirname(configured), { homeDirectory: home, projectRoots: [configured] }),
			403,
		);
	});

	it("browses a configured project root that sits in a folder the home rule hides", async () => {
		const home = tempDirectory("deck-browse-hidden-root-");
		const root = path.join(home, ".work", "proj");
		await fs.mkdir(path.join(root, "src"), { recursive: true });
		await fs.mkdir(path.join(home, ".private", "other"), { recursive: true });

		const listing = await browseNewSessionDirectory(root, { homeDirectory: home, projectRoots: [root] });
		expect(listing.entries.map(entry => entry.name)).toEqual(["src"]);
		await expectBrowseError(browseNewSessionDirectory(path.join(home, ".private", "other"), { homeDirectory: home, projectRoots: [root] }), 403);
	});

	it("caps a scan at 500 directory entries and reports truncation", async () => {
		const home = tempDirectory("deck-browse-wide-home-");
		await Promise.all(Array.from({ length: 501 }, (_, index) => fs.mkdir(path.join(home, `folder-${String(index).padStart(3, "0")}`))));

		const result = await browseNewSessionDirectory(home, { homeDirectory: home });

		expect(result.entries).toHaveLength(500);
		expect(result.truncated).toBe(true);
	});

	it("checks containment using Windows drive and separator rules", () => {
		expect(isPathWithin("C:\\Users\\Leo\\projects", "c:/users/leo/projects/app", path.win32)).toBe(true);
		expect(isPathWithin("C:\\Users\\Leo\\projects", "C:\\Users\\Leo\\projects-old", path.win32)).toBe(false);
	});

	it("returns a paired, plain 403 for a folder outside every allowed root", async () => {
		const daemon = await startTestDaemon({ withoutConfiguredRoots: true });
		const outside = path.parse(daemon.dir).root;
		const response = await daemon.get(`/api/new-session/browse?dir=${encodeURIComponent(outside)}`);
		const body = await response.json() as { code: string; error: string };

		expect(response.status).toBe(403);
		expect(body).toEqual({ code: "forbidden", error: "Choose a folder inside your home folder or a configured project folder." });
		const unauthenticated = await daemon.unauthenticated(`/api/new-session/browse?dir=${encodeURIComponent(outside)}`);
		expect(unauthenticated.status).toBe(401);
	});
});
