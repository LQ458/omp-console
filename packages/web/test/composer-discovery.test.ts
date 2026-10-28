import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { CatalogCommand, CatalogResponse } from "@omp-console/protocol";
import { executeCommand } from "../src/components/catalog/actions";
import {
	attachRejection,
	MAX_IMAGE_BYTES,
	MAX_IMAGES,
	submitPrompt,
	supportsPromptImages,
	type ImageAttachment,
} from "../src/components/composer/images";
import { DeckApi } from "../src/lib/api";
import { CatalogCache, CATALOG_TTL_MS, filterCatalog, tabCounts } from "../src/lib/catalog";
import { daemonTransport, journal } from "../src/lib/journal";
import { type MockDaemon, startMockDaemon } from "../dev/mock-daemon";

const IMAGE: ImageAttachment = { id: 1, name: "a.png", mimeType: "image/png", data: "AAAA", previewUrl: "blob:x" };

describe("prompt images", () => {
	it("refuses to claim image support the client's sendPrompt cannot carry", () => {
		const textOnly = { sendPrompt: (_text: string): void => {} };
		expect(supportsPromptImages(textOnly)).toBe(false);
		const sent: unknown[][] = [];
		expect(submitPrompt({ sendPrompt: (...args: unknown[]) => void sent.push(args) } as typeof textOnly, "hi", [IMAGE])).toBe(false);
		expect(sent).toEqual([["hi"]]);
	});

	it("sends base64 image blocks with the prompt when the client accepts images", () => {
		const sent: Array<[string, unknown]> = [];
		const client = { sendPrompt: (text: string, images?: unknown): void => void sent.push([text, images]) };
		expect(supportsPromptImages(client)).toBe(true);
		expect(submitPrompt(client, "look", [IMAGE])).toBe(true);
		expect(sent).toEqual([["look", [{ type: "image", data: "AAAA", mimeType: "image/png" }]]]);
	});

	it("does not send an image array for a text-only prompt", () => {
		const sent: Array<[string, unknown]> = [];
		const client = { sendPrompt: (text: string, images?: unknown): void => void sent.push([text, images]) };
		submitPrompt(client, "hello", []);
		expect(sent).toEqual([["hello", undefined]]);
	});

	it("rejects non-images, oversize files and a ninth image", () => {
		expect(attachRejection({ type: "application/pdf", size: 10 }, 0)).toBe("not-an-image");
		expect(attachRejection({ type: "image/png", size: MAX_IMAGE_BYTES + 1 }, 0)).toBe("too-large");
		expect(attachRejection({ type: "image/png", size: 10 }, MAX_IMAGES)).toBe("too-many");
		expect(attachRejection({ type: "image/webp", size: 10 }, MAX_IMAGES - 1)).toBeNull();
	});
});

const catalog: CatalogResponse = {
	commands: [
		{ name: "compact", source: "builtin", remote: true, description: "Compact context" },
		{ name: "tree", source: "builtin", remote: false },
	],
	tools: [
		{ name: "read", description: "Read a file" },
		{ name: "bash", description: "Run a shell command" },
	],
	profiles: [
		{ name: "reviewer", source: "bundled", description: "Reviews work", definitionModels: [], tools: ["read", "grep"] },
		{ name: "scout", source: "bundled", description: "Maps code", definitionModels: [], tools: ["glob"] },
	],
	skills: [{ name: "visual-review", description: "Review a visual artifact" }],
	roles: { default: "anthropic/claude-sonnet-5-5", smol: "openai-codex/gpt-6-luna" },
	mcp: [{ name: "siyuan", connected: true }],
	generatedAt: 1,
};

describe("catalog filtering", () => {
	it("filters every tab by the same query and reports per-tab counts", () => {
		const view = filterCatalog(catalog, "read");
		expect(tabCounts(view)).toEqual({ commands: 0, tools: 1, profiles: 1, skills: 0, roles: 0, mcp: 0 });
		expect(view.profiles[0]?.name).toBe("reviewer");
	});

	it("matches model roles by role name or selector, and skills by description", () => {
		expect(filterCatalog(catalog, "luna").roles).toEqual([["smol", "openai-codex/gpt-6-luna"]]);
		expect(filterCatalog(catalog, "artifact").skills.map(s => s.name)).toEqual(["visual-review"]);
	});

	it("shows everything for an empty query", () => {
		expect(tabCounts(filterCatalog(catalog, ""))).toEqual({ commands: 2, tools: 2, profiles: 2, skills: 1, roles: 2, mcp: 1 });
	});
});

describe("catalog cache", () => {
	it("shares one in-flight request, reuses a fresh entry, and refetches when forced or expired", async () => {
		let calls = 0;
		let clock = 0;
		const cache = new CatalogCache(() => clock);
		const api = {
			catalog: async (): Promise<CatalogResponse> => {
				calls++;
				await Bun.sleep(0);
				return { ...catalog, generatedAt: calls };
			},
		};
		const [a, b] = await Promise.all([cache.load(api, "s1"), cache.load(api, "s1")]);
		expect(calls).toBe(1);
		expect(a).toBe(b);
		await cache.load(api, "s1");
		expect(calls).toBe(1);
		await cache.load(api, "s1", true);
		expect(calls).toBe(2);
		clock = CATALOG_TTL_MS + 1;
		expect((await cache.load(api, "s1")).generatedAt).toBe(3);
		expect((await cache.load(api, "s2")).generatedAt).toBe(4);
	});
});

describe("palette actions against the mock daemon", () => {
	let daemon: MockDaemon;
	let api: DeckApi;
	let sessionId: string;

	beforeEach(async () => {
		daemon = await startMockDaemon({ port: 0, seed: true });
		const base = daemon.url;
		api = new DeckApi({ base: `${base}/api` });
		sessionId = daemon.liveIds()[0] ?? "";
		journal.bind(null);
	});

	afterEach(async () => {
		await daemon.stop();
	});

	const command = async (name: string): Promise<CatalogCommand> => {
		const found = (await api.catalog(sessionId)).commands.find(c => c.name === name);
		if (!found) throw new Error(`mock catalog has no /${name}`);
		return found;
	};

	it("advertises every omp-console-native terminal control instead of labeling it terminal-only", async () => {
		const names = ["pause", "queue", "restart", "collab", "join", "leave", "open", "copy", "hotkeys", "extensions", "exit", "quit", "live", "debug"];
		const commands = (await api.catalog(sessionId)).commands;
		expect(names.map(name => commands.find(command => command.name === name)?.deckControl)).toEqual([
			"pause",
			"queue",
			"restart",
			"collab",
			"join",
			"leave",
			"open",
			"copy",
			"hotkeys",
			"extensions",
			"leave",
			"leave",
			"live",
			"debug",
		]);
	});

	/** Slash commands the mock daemon actually received (`/api/mock/commands`). */
	const received = async (): Promise<string[]> =>
		(await (await fetch(`${daemon.url}/api/mock/commands`)).json()) as string[];

	it("runs a remote command through the daemon and reports it ran", async () => {
		const outcome = await executeCommand(await command("compact"), "soft", { api, sessionId, via: "palette" });
		expect(outcome).toEqual({ kind: "ran", text: "/compact soft" });
		expect(await received()).toEqual(["/compact soft"]);
	});

	it("opens an omp console panel for a TUI-only command with a control instead of calling the daemon", async () => {
		const opened: string[] = [];
		const outcome = await executeCommand(await command("model"), "", {
			api,
			sessionId,
			via: "palette",
			open: detail => void opened.push(detail.panel),
		});
		expect(outcome.kind).toBe("panel");
		expect(opened).toEqual(["model"]);
		expect(await received()).toEqual([]);
	});

	it("routes /live and /debug through their mock panels without sending slash commands", async () => {
		const opened: string[] = [];
		for (const [name, panel] of [["live", "live"], ["debug", "debug"]] as const) {
			const outcome = await executeCommand(await command(name), "", {
				api,
				sessionId,
				via: "palette",
				open: detail => void opened.push(detail.panel),
			});
			expect(outcome).toMatchObject({ kind: "panel", panel });
		}
		expect(opened).toEqual(["live", "debug"]);
		expect(await received()).toEqual([]);
	});

	it("puts a command that needs an argument into the composer instead of running it bare", async () => {
		const inserted: string[] = [];
		const outcome = await executeCommand(await command("goal"), "", {
			api,
			sessionId,
			via: "palette",
			insert: detail => void inserted.push(detail.text),
		});
		expect(outcome).toEqual({ kind: "filled", text: "/goal " });
		expect(inserted).toEqual(["/goal "]);
		expect(await received()).toEqual([]);
	});

	it("shows the omp text to copy for a terminal-only command", async () => {
		const outcome = await executeCommand(await command("tree"), "", { api, sessionId, via: "catalog" });
		expect(outcome).toEqual({ kind: "terminal", text: "/tree", equivalent: "/tree" });
	});

	it("turns a daemon refusal into a readable error and records the failure", async () => {
		const forced: CatalogCommand = { name: "tree", source: "builtin", remote: true };
		const outcome = await executeCommand(forced, "", { api, sessionId, via: "palette" });
		expect(outcome.kind).toBe("error");
		if (outcome.kind === "error") expect(outcome.message).toContain("cannot run from the app");
	});

	it("journals palette use without the arguments the user typed, and the daemon stores exactly that", async () => {
		journal.bind(daemonTransport(api));
		await executeCommand(await command("goal"), "ship the secret launch plan", { api, sessionId, via: "palette" });
		await journal.flush();
		const stored = await api.readJournal();
		const entry = stored.events.find(e => e.feature === "5.2.palette" && e.detail === "goal" && e.action === "run");
		expect(entry).toMatchObject({ action: "run", outcome: "ok", via: "palette", detail: "goal" });
		expect(JSON.stringify(stored)).not.toContain("secret launch plan");
		journal.bind(null);
	});

	it("serves file suggestions that follow directories, and refuses an unknown session", async () => {
		const top = await api.fileSuggestions(sessionId, "src/relay/");
		expect(top.items.map(i => i.path)).toEqual(["src/relay/backoff.ts", "src/relay/socket.ts", "src/relay/socket.test.ts"]);
		await expect(api.fileSuggestions("nope", "x")).rejects.toMatchObject({ kind: "not-found" });
	});
});
