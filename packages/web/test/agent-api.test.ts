import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { ListModelsResponse, ListProfilesResponse, SetAgentModelResponse } from "@omp-console/protocol";
import { AGENT_TREE_SESSION_ID } from "../dev/agent-tree-fixture";
import { type MockDaemon, startMockDaemon } from "../dev/mock-daemon";
import { describeControlError } from "../src/lib/agent-api";
import { buildModelGroups, changeAgentModel } from "../src/lib/agent-models";
import { DeckApi, DeckApiError, type FetchLike } from "../src/lib/api";

interface Call {
	url: string;
	method: string;
	body: unknown;
}

function fakeFetch(responses: Array<Response | Error>): { fetch: FetchLike; calls: Call[] } {
	const calls: Call[] = [];
	const fetch: FetchLike = async (input, init) => {
		calls.push({
			url: input,
			method: init?.method ?? "GET",
			body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
		});
		const next = responses.shift();
		if (!next) throw new Error("unexpected request");
		if (next instanceof Error) throw next;
		return next;
	};
	return { fetch, calls };
}

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function failureOf(promise: Promise<unknown>): Promise<DeckApiError> {
	try {
		await promise;
	} catch (err) {
		if (err instanceof DeckApiError) return err;
		throw err;
	}
	throw new Error("expected the call to fail");
}

describe("DeckApi model and profile requests", () => {
	it("encodes ids into the path and sends the selector bodies the protocol defines", async () => {
		const models: ListModelsResponse = { models: [], roles: { default: "a/b" } };
		const profiles: ListProfilesResponse = { profiles: [], roles: {} };
		const changed: SetAgentModelResponse = { agentId: "a/b", model: "p/m" };
		const { fetch, calls } = fakeFetch([
			json(models),
			json(changed),
			json(profiles),
			new Response(null, { status: 204 }),
			new Response(null, { status: 204 }),
			new Response(null, { status: 204 }),
		]);
		const api = new DeckApi({ fetch });
		expect(await api.listModels()).toEqual(models);
		expect(await api.setAgentModel("s 1", "a/b", "p/m")).toEqual(changed);
		expect(await api.listProfiles()).toEqual(profiles);
		await api.setProfileModel("reviewer", "p/m");
		await api.setProfileModel("reviewer", null);
		await api.setModelRole("smol", "p/m");
		expect(calls).toEqual([
			{ url: "/api/models", method: "GET", body: undefined },
			{ url: "/api/sessions/s%201/agents/a%2Fb/model", method: "POST", body: { selector: "p/m" } },
			{ url: "/api/profiles", method: "GET", body: undefined },
			{ url: "/api/profiles/reviewer/model", method: "PUT", body: { selector: "p/m" } },
			{ url: "/api/profiles/reviewer/model", method: "PUT", body: { selector: null } },
			{ url: "/api/model-roles/smol", method: "PUT", body: { selector: "p/m" } },
		]);
	});

	it("maps statuses to failure kinds and keeps the daemon's message", async () => {
		const api = new DeckApi({
			fetch: fakeFetch([
				json({ error: "no agent x", code: "not-found" }, 404),
				json({ error: "no live session", code: "conflict" }, 409),
				json({ error: "no model matches q", code: "bad-request" }, 400),
				json({ error: "owner identity required", code: "unauthorized" }, 401),
				new Response("<html>bad gateway</html>", { status: 502 }),
				new Error("connect ECONNREFUSED"),
			]).fetch,
		});
		const kinds: Array<[DeckApiError["kind"], string]> = [];
		for (let i = 0; i < 6; i++) {
			const err = await failureOf(api.setAgentModel("s", "x", "q"));
			kinds.push([err.kind, err.message]);
		}
		expect(kinds).toEqual([
			["not-found", "no agent x"],
			["conflict", "no live session"],
			["bad-request", "no model matches q"],
			["auth", "owner identity required"],
			["server", "request failed (502)"],
			["network", "daemon unreachable"],
		]);
	});

	it("turns each failure kind into one sentence the person can act on", () => {
		const err = (kind: DeckApiError["kind"], message = "boom"): DeckApiError => new DeckApiError(kind, 0, message);
		expect(describeControlError(err("conflict"), "agent-model")).toContain("Revive it first");
		expect(describeControlError(err("not-found"), "agent-model")).toContain("gone");
		expect(describeControlError(err("bad-request", "no model matches q"), "agent-model")).toContain("no model matches q");
		expect(describeControlError(err("network"), "profile-model")).toContain("Nothing was changed");
		expect(describeControlError(err("auth"), "load")).toContain("refused");
		expect(describeControlError(new Error("odd"), "load")).toBe("odd");
	});
});

describe("model and profile endpoints against the mock daemon", () => {
	let daemon: MockDaemon;
	let api: DeckApi;

	beforeAll(async () => {
		daemon = await startMockDaemon({ port: 0, seed: false, agentTree: true });
		api = new DeckApi({ base: `${daemon.url}/api` });
	});
	afterAll(async () => {
		await daemon.stop();
	});

	it("changes the model of the root agent and of a running subagent, resolving role aliases", async () => {
		const root = await changeAgentModel(api, AGENT_TREE_SESSION_ID, "main", "anthropic/claude-opus-5-5");
		expect(root).toEqual({ ok: true, model: "anthropic/claude-opus-5-5", thinkingLevel: undefined });
		const sub = await changeAgentModel(api, AGENT_TREE_SESSION_ID, "RelayProbe", "smol");
		expect(sub.ok && sub.model).toBe("openai-codex/gpt-6-luna");
	});

	it("reports an inline reason for a parked agent, an unknown agent, an unusable model and an unknown session", async () => {
		const parked = await changeAgentModel(api, AGENT_TREE_SESSION_ID, "Planner", "anthropic/claude-opus-5-5");
		expect(parked).toEqual({ ok: false, message: expect.stringContaining("no live session") });
		const unknown = await changeAgentModel(api, AGENT_TREE_SESSION_ID, "ghost", "anthropic/claude-opus-5-5");
		expect(unknown).toEqual({ ok: false, message: expect.stringContaining("gone") });
		const unavailable = await changeAgentModel(api, AGENT_TREE_SESSION_ID, "main", "google/gemini-3-pro");
		expect(unavailable).toEqual({ ok: false, message: expect.stringContaining("not available") });
		const nonsense = await changeAgentModel(api, AGENT_TREE_SESSION_ID, "main", "no-such-model-xyz");
		expect(nonsense).toEqual({ ok: false, message: expect.stringContaining("no model matches") });
		const session = await changeAgentModel(api, "nope", "main", "smol");
		expect(session).toEqual({ ok: false, message: expect.stringContaining("gone") });
	});

	it("serves the picker's data: unavailable models are listed and flagged, roles resolve to listed models", async () => {
		const response = await api.listModels();
		const groups = buildModelGroups(response, "");
		const gemini = groups.flatMap(group => group.items).find(item => item.selector === "google/gemini-3-pro");
		expect(gemini?.available).toBe(false);
		for (const target of Object.values(response.roles)) {
			expect(response.models.some(model => model.selector === target)).toBe(true);
		}
	});
});
