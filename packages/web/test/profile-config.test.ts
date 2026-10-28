import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { ListModelsResponse, ListProfilesResponse } from "@omp-console/protocol";
import { type MockDaemon, startMockDaemon } from "../dev/mock-daemon";
import { DeckApi, type FetchLike } from "../src/lib/api";
import { ProfileConfigStore } from "../src/lib/profile-config";

const MODELS: ListModelsResponse = {
	models: [{ selector: "p/m", provider: "p", label: "M", available: true }],
	roles: { default: "p/m" },
};

/** A scripted daemon: GET /profiles and /models read live state; PUTs are recorded and may be made to fail. */
function scriptedDaemon(): {
	fetch: FetchLike;
	puts: Array<{ url: string; body: unknown }>;
	state: { override: string | undefined; role: string; failNextPut: Response | null };
} {
	const puts: Array<{ url: string; body: unknown }> = [];
	const state: { override: string | undefined; role: string; failNextPut: Response | null } = {
		override: undefined,
		role: "p/m",
		failNextPut: null,
	};
	const fetch: FetchLike = async (input, init) => {
		const json = (body: unknown): Response =>
			new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
		if (init?.method === "PUT") {
			const body = JSON.parse(String(init.body)) as { selector: string | null };
			puts.push({ url: input, body });
			if (state.failNextPut) {
				const failure = state.failNextPut;
				state.failNextPut = null;
				return failure;
			}
			if (input.startsWith("/api/profiles/")) state.override = body.selector ?? undefined;
			else state.role = body.selector as string;
			return new Response(null, { status: 204 });
		}
		if (input === "/api/models") return json(MODELS);
		const profiles: ListProfilesResponse = {
			profiles: [
				{ name: "reviewer", source: "user", definitionModels: ["default"], override: state.override, effectiveModel: state.override ?? "p/m" },
			],
			roles: { default: state.role },
		};
		return json(profiles);
	};
	return { fetch, puts, state };
}

describe("ProfileConfigStore edit flow", () => {
	it("writes nothing until a value is chosen and confirmed", async () => {
		const daemon = scriptedDaemon();
		const store = new ProfileConfigStore(new DeckApi({ fetch: daemon.fetch }));
		await store.load();
		expect(store.getSnapshot().profiles.map(profile => profile.name)).toEqual(["reviewer"]);

		store.begin({ kind: "profile", name: "reviewer" });
		expect(await store.confirm()).toBe(false); // nothing chosen yet
		store.choose("p/m");
		expect(store.getSnapshot().edit?.stage).toBe("confirm");
		expect(daemon.puts).toEqual([]); // choosing is not saving

		store.back();
		expect(store.getSnapshot().edit?.stage).toBe("choose");
		expect(await store.confirm()).toBe(false); // back at the chooser: confirm is refused
		store.choose("p/m");
		store.cancel();
		expect(store.getSnapshot().edit).toBeNull();
		expect(await store.confirm()).toBe(false);
		expect(daemon.puts).toEqual([]);
	});

	it("saves once on confirm, reloads the effective model and reports what changed", async () => {
		const daemon = scriptedDaemon();
		const store = new ProfileConfigStore(new DeckApi({ fetch: daemon.fetch }));
		await store.load();
		store.begin({ kind: "profile", name: "reviewer" });
		store.choose("p/m");
		const first = store.confirm();
		const second = store.confirm(); // a double tap while saving must not send twice
		expect(await first).toBe(true);
		expect(await second).toBe(false);
		expect(daemon.puts).toEqual([{ url: "/api/profiles/reviewer/model", body: { selector: "p/m" } }]);
		const snap = store.getSnapshot();
		expect(snap.edit).toBeNull();
		expect(snap.profiles[0]?.override).toBe("p/m");
		expect(snap.saved).toBe("Set profile reviewer to p/m.");
	});

	it("clears an override with null and never lets a role be cleared", async () => {
		const daemon = scriptedDaemon();
		daemon.state.override = "p/m";
		const store = new ProfileConfigStore(new DeckApi({ fetch: daemon.fetch }));
		await store.load();
		store.begin({ kind: "profile", name: "reviewer" });
		expect(store.getSnapshot().edit?.before).toBe("p/m");
		store.choose(null);
		await store.confirm();
		expect(daemon.puts).toEqual([{ url: "/api/profiles/reviewer/model", body: { selector: null } }]);
		expect(store.getSnapshot().profiles[0]?.override).toBeUndefined();
		expect(store.getSnapshot().saved).toBe("Cleared the override for profile reviewer.");

		store.begin({ kind: "role", role: "default" });
		store.choose(null);
		expect(store.getSnapshot().edit?.stage).toBe("choose");
	});

	it("keeps the confirm step open with the daemon's reason when the write fails, and retries cleanly", async () => {
		const daemon = scriptedDaemon();
		const store = new ProfileConfigStore(new DeckApi({ fetch: daemon.fetch }));
		await store.load();
		store.begin({ kind: "role", role: "default" });
		store.choose("p/m");
		daemon.state.failNextPut = new Response(JSON.stringify({ error: "no model matches q", code: "bad-request" }), { status: 400 });
		expect(await store.confirm()).toBe(false);
		let edit = store.getSnapshot().edit;
		expect(edit?.stage).toBe("confirm");
		expect(edit?.error).toContain("no model matches q");
		expect(store.getSnapshot().saved).toBeNull();
		expect(await store.confirm()).toBe(true);
		edit = store.getSnapshot().edit;
		expect(edit).toBeNull();
		expect(daemon.puts.map(put => put.url)).toEqual(["/api/model-roles/default", "/api/model-roles/default"]);
	});

	it("shows a failed load as an error and still allows a retry", async () => {
		let up = false;
		const fetch: FetchLike = async input => {
			if (!up) return new Response(JSON.stringify({ error: "nope", code: "unauthorized" }), { status: 401 });
			return new Response(JSON.stringify(input === "/api/models" ? MODELS : { profiles: [], roles: { default: "p/m" } }), { status: 200 });
		};
		const store = new ProfileConfigStore(new DeckApi({ fetch }));
		await store.load();
		expect(store.getSnapshot().load).toBe("error");
		expect(store.getSnapshot().loadError).toContain("refused");
		up = true;
		await store.load();
		expect(store.getSnapshot().load).toBe("ready");
		expect(store.getSnapshot().roles).toEqual({ default: "p/m" });
	});
});

describe("profile edits against the mock daemon", () => {
	let daemon: MockDaemon;
	let store: ProfileConfigStore;

	beforeAll(async () => {
		daemon = await startMockDaemon({ port: 0, seed: false });
		store = new ProfileConfigStore(new DeckApi({ base: `${daemon.url}/api` }));
		await store.load();
	});
	afterAll(async () => {
		await daemon.stop();
	});

	it("an override changes the effective model on the next load; clearing falls back to the definition", async () => {
		const reviewer = () => store.getSnapshot().profiles.find(profile => profile.name === "reviewer")!;
		expect(reviewer().override).toBeUndefined();
		expect(reviewer().effectiveModel).toBe("anthropic/claude-opus-5-5"); // definition: role plan
		store.begin({ kind: "profile", name: "reviewer" });
		store.choose("anthropic/claude-haiku-5-5");
		expect(await store.confirm()).toBe(true);
		expect(reviewer().override).toBe("anthropic/claude-haiku-5-5");
		expect(reviewer().effectiveModel).toBe("anthropic/claude-haiku-5-5");
		store.begin({ kind: "profile", name: "reviewer" });
		store.choose(null);
		expect(await store.confirm()).toBe(true);
		expect(reviewer().override).toBeUndefined();
		expect(reviewer().effectiveModel).toBe("anthropic/claude-opus-5-5");
	});

	it("a role change is visible to every profile that resolves through it, and an unusable model is refused", async () => {
		store.begin({ kind: "role", role: "plan" });
		store.choose("google/gemini-3-pro");
		expect(await store.confirm()).toBe(false);
		expect(store.getSnapshot().edit?.error).toContain("not available");
		store.choose("anthropic/claude-sonnet-5-5");
		expect(await store.confirm()).toBe(true);
		const reviewer = store.getSnapshot().profiles.find(profile => profile.name === "reviewer")!;
		expect(reviewer.effectiveModel).toBe("anthropic/claude-sonnet-5-5");
		expect(store.getSnapshot().roles.plan).toBe("anthropic/claude-sonnet-5-5");
	});
});
