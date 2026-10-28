import { describe, expect, it } from "bun:test";
import {
	applyMention,
	findMentionTrigger,
	formatDroppedPath,
	formatFileMention,
	insertAtSelection,
	parseFileUris,
	planDrop,
	relativeToCwd,
	SuggestionLoader,
} from "../src/lib/mentions";

/** `text` with `|` marking the caret. */
function at(marked: string) {
	const caret = marked.indexOf("|");
	return findMentionTrigger(marked.replace("|", ""), caret);
}

describe("mention triggers", () => {
	it("opens a file mention at a token start and reads the query up to the caret", () => {
		expect(at("look at @src/re|")).toMatchObject({ kind: "file", start: 8, query: "src/re", quoted: false });
		expect(at("@|")).toMatchObject({ kind: "file", start: 0, query: "" });
	});

	it("ignores an @ inside a word (email addresses) but accepts omp's boundary characters", () => {
		expect(at("mail me at alice@example.com|")).toBeNull();
		expect(at('see ("@docs/a|')).toMatchObject({ kind: "file", query: "docs/a" });
	});

	it("keeps a quoted mention open across spaces and replaces through the closing quote", () => {
		const trigger = at('read @"docs/release n|otes.md" now');
		expect(trigger).toMatchObject({ kind: "file", quoted: true, query: "docs/release n" });
		const text = 'read @"docs/release notes.md" now';
		expect(text.slice(trigger?.start, trigger?.end)).toBe('@"docs/release notes.md"');
	});

	it("does not treat the text after a closed quoted mention as part of it", () => {
		expect(at('@"a b" and some|')).toBeNull();
	});

	it("opens a model mention at a token start only", () => {
		expect(at("use ^anthropic/cl|")).toMatchObject({ kind: "model", query: "anthropic/cl" });
		expect(at("x^2 + ^|")).toMatchObject({ kind: "model", query: "" });
		expect(at("x^|")).toBeNull();
	});

	it("opens the command palette only for a slash at the start of the composer, and closes it after the name", () => {
		expect(at("/comp|")).toMatchObject({ kind: "command", query: "comp", start: 0 });
		expect(at("  /comp|")).toMatchObject({ kind: "command", query: "comp", start: 2 });
		expect(at("run /comp|")).toBeNull();
		expect(at("/compact so|")).toBeNull();
	});

	it("replaces the whole token when the caret sits inside it", () => {
		const text = "see @src/relay and more";
		const trigger = findMentionTrigger(text, 8);
		expect(trigger && text.slice(trigger.start, trigger.end)).toBe("@src/relay");
	});
});

describe("mention formatting and acceptance", () => {
	it("quotes only paths omp could not parse bare", () => {
		expect(formatFileMention("src/index.ts")).toBe("@src/index.ts");
		expect(formatFileMention("docs/release notes.md")).toBe('@"docs/release notes.md"');
		expect(formatFileMention("it's here/a b.md")).toBe('@"it\'s here/a b.md"');
		expect(formatFileMention('say "hi"/a b.md')).toBe("@'say \"hi\"/a b.md'");
		expect(formatFileMention("a@b/c.md")).toBe('@"a@b/c.md"');
	});

	it("leaves a quoted directory unclosed so the next segment keeps completing", () => {
		expect(formatFileMention("my docs/", true)).toBe('@"my docs/');
		const trigger = findMentionTrigger('@"my docs/', 10);
		expect(trigger).toMatchObject({ kind: "file", quoted: true, query: "my docs/" });
	});

	it("accepts a file with a trailing space and a directory without, and moves the caret after the insertion", () => {
		const text = "look @sr";
		const trigger = findMentionTrigger(text, text.length);
		if (!trigger) throw new Error("no trigger");
		expect(applyMention(text, trigger, "@src/", false)).toEqual({ text: "look @src/", caret: 10 });
		expect(applyMention(text, trigger, "@src/index.ts", true)).toEqual({ text: "look @src/index.ts ", caret: 19 });
	});

	it("does not double the space when text already follows the mention", () => {
		const text = "@sr and more";
		const trigger = findMentionTrigger(text, 3);
		if (!trigger) throw new Error("no trigger");
		const next = applyMention(text, trigger, "@src/a.ts", true);
		expect(next.text).toBe("@src/a.ts and more");
		expect(next.caret).toBe(10);
	});

	it("inserts a drop between neighbours without gluing words together", () => {
		expect(insertAtSelection("fix", 3, 3, "@a.ts")).toEqual({ text: "fix @a.ts ", caret: 10 });
		expect(insertAtSelection("fix  bug", 4, 4, "@a.ts")).toEqual({ text: "fix @a.ts bug", caret: 10 });
	});
});

describe("dropped files", () => {
	const CWD = "/Users/alice/work/relay";

	it("maps a file under the session cwd to a relative mention", () => {
		expect(formatDroppedPath(`${CWD}/src/index.ts`, CWD)).toBe("@src/index.ts");
		expect(formatDroppedPath(`${CWD}/docs/release notes.md`, CWD)).toBe('@"docs/release notes.md"');
		expect(formatDroppedPath(`${CWD}/src/`, CWD)).toBe("@src/");
	});

	it("maps a file outside the cwd to a quoted absolute mention, including a sibling that shares the cwd prefix", () => {
		expect(formatDroppedPath("/Users/alice/Desktop/a.png", CWD)).toBe('@"/Users/alice/Desktop/a.png"');
		expect(formatDroppedPath(`${CWD}-old/a.ts`, CWD)).toBe(`@"${CWD}-old/a.ts"`);
		expect(formatDroppedPath("/etc/hosts", undefined)).toBe('@"/etc/hosts"');
	});

	it("resolves dot segments before deciding inside or outside", () => {
		expect(relativeToCwd(`${CWD}/src/../README.md`, CWD)).toBe("README.md");
		expect(relativeToCwd(`${CWD}/../other/x.ts`, CWD)).toBeNull();
		expect(relativeToCwd(CWD, CWD)).toBe(".");
	});

	it("reads only local file:// URIs from a drop and decodes them", () => {
		const list = [
			"# Finder",
			"file:///Users/alice/work/relay/docs/release%20notes.md",
			"file://localhost/Users/alice/a.txt",
			"file://otherhost/Users/alice/b.txt",
			"https://example.com/x",
		].join("\r\n");
		expect(parseFileUris(list)).toEqual(["/Users/alice/work/relay/docs/release notes.md", "/Users/alice/a.txt"]);
	});

	it("keeps dragged prose that looks like a path out of the mentions", () => {
		const plan = planDrop({ uriList: "", text: "/compact", files: [] });
		expect(plan).toEqual({ mentionPaths: [], images: [], nonImages: [], unmatchedPaths: [] });
	});

	it("splits one drop into mentions, prompt images and files whose path the browser hid", () => {
		const plan = planDrop({
			uriList: ["file:///Users/alice/Desktop/shot.png", "file:///Users/alice/Desktop/notes.md"].join("\n"),
			text: "",
			files: [
				{ name: "shot.png", type: "image/png" },
				{ name: "notes.md", type: "text/markdown" },
				{ name: "secret.pdf", type: "application/pdf" },
			],
		});
		expect(plan.images).toEqual([{ index: 0, path: "/Users/alice/Desktop/shot.png" }]);
		expect(plan.mentionPaths).toEqual(["/Users/alice/Desktop/notes.md"]);
		expect(plan.nonImages).toEqual([
			{ index: 1, path: "/Users/alice/Desktop/notes.md" },
			{ index: 2, path: undefined },
		]);
		expect(plan.unmatchedPaths).toEqual([]);
	});

	it("reports an image whose path is hidden without inventing one", () => {
		const plan = planDrop({ uriList: "", text: "", files: [{ name: "a.webp", type: "image/webp" }] });
		expect(plan.images).toEqual([{ index: 0, path: undefined }]);
		expect(plan.mentionPaths).toEqual([]);
		expect(plan.nonImages).toEqual([]);
		expect(plan.unmatchedPaths).toEqual([]);
	});

	it("keeps exposed paths without file bytes separate for remote-session safety", () => {
		const plan = planDrop({ uriList: "file:///Users/alice/Desktop/report.pdf", text: "", files: [] });
		expect(plan).toEqual({
			mentionPaths: ["/Users/alice/Desktop/report.pdf"],
			images: [],
			nonImages: [],
			unmatchedPaths: ["/Users/alice/Desktop/report.pdf"],
		});
	});

});

describe("SuggestionLoader", () => {
	/** Manual clock: timers fire only when the test says so. */
	function clock() {
		const timers = new Map<number, () => void>();
		let next = 0;
		return {
			schedule(fn: () => void): () => void {
				const id = next++;
				timers.set(id, fn);
				return () => timers.delete(id);
			},
			fireAll(): void {
				const pending = [...timers.values()];
				timers.clear();
				for (const fn of pending) fn();
			},
			pending: () => timers.size,
		};
	}

	it("debounces: three keystrokes before the timer fire one lookup, for the last query", async () => {
		const c = clock();
		const loaded: string[] = [];
		const results: string[] = [];
		const loader = new SuggestionLoader<string>({
			schedule: c.schedule,
			load: async q => {
				loaded.push(q);
				return q;
			},
			onResult: (_q, v) => results.push(v),
			onError: () => {},
		});
		loader.request("s");
		loader.request("sr");
		loader.request("src");
		expect(c.pending()).toBe(1);
		c.fireAll();
		await Bun.sleep(0);
		expect(loaded).toEqual(["src"]);
		expect(results).toEqual(["src"]);
	});

	it("aborts the in-flight request and drops its result when a newer query supersedes it, even if the loader ignores the signal", async () => {
		const c = clock();
		const signals: AbortSignal[] = [];
		const resolvers: Array<(value: string) => void> = [];
		const results: string[] = [];
		const loader = new SuggestionLoader<string>({
			schedule: c.schedule,
			load: (_q, signal) => {
				signals.push(signal);
				const { promise, resolve } = Promise.withResolvers<string>();
				resolvers.push(resolve);
				return promise;
			},
			onResult: (_q, v) => results.push(v),
			onError: () => {},
		});
		loader.request("a");
		c.fireAll();
		loader.request("ab");
		expect(signals[0]?.aborted).toBe(true);
		c.fireAll();
		resolvers[1]?.("fresh");
		await Bun.sleep(0);
		resolvers[0]?.("stale");
		await Bun.sleep(0);
		expect(results).toEqual(["fresh"]);
	});

	it("swallows an error from a superseded request but reports one from the current request", async () => {
		const c = clock();
		const errors: string[] = [];
		const rejecters: Array<(reason: Error) => void> = [];
		const loader = new SuggestionLoader<string>({
			schedule: c.schedule,
			load: () => {
				const { promise, reject } = Promise.withResolvers<string>();
				rejecters.push(reject);
				return promise;
			},
			onResult: () => {},
			onError: (q, err) => errors.push(`${q}:${(err as Error).message}`),
		});
		loader.request("a");
		c.fireAll();
		loader.request("b");
		c.fireAll();
		rejecters[0]?.(new Error("aborted"));
		rejecters[1]?.(new Error("down"));
		await Bun.sleep(0);
		expect(errors).toEqual(["b:down"]);
	});

	it("cancel() stops a pending timer so no request is made", () => {
		const c = clock();
		let calls = 0;
		const loader = new SuggestionLoader<string>({
			schedule: c.schedule,
			load: async () => {
				calls++;
				return "";
			},
			onResult: () => {},
			onError: () => {},
		});
		loader.request("x");
		loader.cancel();
		c.fireAll();
		expect(calls).toBe(0);
	});
});
