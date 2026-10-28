import { describe, expect, test } from "bun:test";
import type { SkillSearchResponse } from "@oh-my-pi/pi-wire/skillshare";
import { SkillshareClient } from "@oh-my-pi/pi-coding-agent/skillshare/client";
import type { SkillChange as InstallerSkillChange, SkillInstallHooks } from "@oh-my-pi/pi-coding-agent/skillshare/installer";
import type { CollabGuestUiResult, CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import type { CollabUiRequestDraft } from "@oh-my-pi/pi-wire";
import { createGuestUiContext } from "../src/guest-ui";
import { SkillsService } from "../src/skills";

describe("Deck skill operations", () => {
	test("search returns usable registry cards and closes its client", async () => {
		let queried = "";
		let closed = false;
		const response = {
			hits: [
				{
					scope: "deck",
					name: "review",
					version: "1.2.0",
					description: "Review a change",
					weeklyDownloads: 32,
					updatedAt: 1_800_000_000_000,
					publisher: { username: "example-user" },
					keywords: ["review", "git"],
					deprecated: null,
				},
			],
			page: 1,
			perPage: 20,
			total: 1,
		} as unknown as SkillSearchResponse;
		const client = {
			search: async (query: string) => {
				queried = query;
				return response;
			},
			close: () => {
				closed = true;
			},
		} as unknown as SkillshareClient;
		const service = new SkillsService({
			cwd: "/session/project",
			session: { isStreaming: false, isCompacting: false, refreshSkillsAndCommands: async () => {} },
			ui: { confirm: async () => false },
			onCatalogChanged: () => {},
			createClient: async () => client,
		});

		expect(await service.search("code review")).toEqual({
			hits: [
				{
					scope: "deck",
					name: "review",
					version: "1.2.0",
					description: "Review a change",
					weeklyDownloads: 32,
					updatedAt: 1_800_000_000_000,
					publisher: { username: "example-user" },
					keywords: ["review", "git"],
				},
			],
			page: 1,
			perPage: 20,
			total: 1,
		});
		expect(queried).toBe("code review");
		expect(closed).toBe(true);
	});

	test("script-bearing installs require an explicit, correlated confirmation and refresh only after a change", async () => {
		let allowScripts = false;
		let refreshes = 0;
		let catalogInvalidations = 0;
		let clientClosed = 0;
		let confirmationTitle = "";
		let confirmationMessage = "";
		let confirmationTimeout: number | undefined;
		let confirmationSignal: AbortSignal | undefined;
		const client = { close: () => clientClosed++ } as unknown as SkillshareClient;
		const service = new SkillsService({
			cwd: "/session/project",
			session: {
				isStreaming: false,
				isCompacting: false,
				refreshSkillsAndCommands: async () => {
					refreshes++;
				},
			},
			ui: {
				confirm: async (title, message, options) => {
					confirmationTitle = title;
					confirmationMessage = message;
					confirmationTimeout = options?.timeout;
					confirmationSignal = options?.signal;
					return allowScripts;
				},
			},
			onCatalogChanged: () => catalogInvalidations++,
			createClient: async () => client,
			operations: {
				install: async (_client, options, hooks: SkillInstallHooks): Promise<InstallerSkillChange[]> => {
					expect(options.yes).toBe(false);
					const approved = await hooks.confirmScripts({
						id: "@omp-console/review",
						version: "1.2.0",
						files: [{ path: "scripts/setup.ts", executable: true, size: 12, sha256: "a".repeat(64) }],
					});
					if (!approved) throw new Error("Installation of @omp-console/review@1.2.0 was declined");
					return [{ id: "@omp-console/review", to: "1.2.0", range: "^1.2.0", restored: false }];
				},
				update: async () => [],
				listInstalled: async cwd => {
					expect(cwd).toBe("/session/project");
					return [];
				},
			},
		});

		const controller = new AbortController();
		await expect(service.install(["@omp-console/review"], false, { approvalId: "install-1", signal: controller.signal })).rejects.toThrow("was declined");
		expect(confirmationTitle).toBe("Install skill with scripts?");
		expect(confirmationMessage).toContain("@omp-console/review@1.2.0 ships scripts:");
		expect(confirmationMessage).toContain("scripts/setup.ts (executable)");
		expect(confirmationMessage).toContain("[omp-console-skill-approval:install-1]");
		expect(confirmationTimeout).toBe(120_000);
		expect(confirmationSignal).toBe(controller.signal);
		expect(refreshes).toBe(0);
		expect(catalogInvalidations).toBe(0);

		allowScripts = true;
		const result = await service.install(["@omp-console/review"], false, { approvalId: "install-2" });
		expect(result.changes).toEqual([{ id: "@omp-console/review", to: "1.2.0", range: "^1.2.0", restored: false }]);
		expect(refreshes).toBe(1);
		expect(catalogInvalidations).toBe(1);
		expect(clientClosed).toBe(2);
	});

	test("an unanswered script approval times out to No and a late answer cannot install", async () => {
		let lateAnswer: ((result: CollabGuestUiResult) => void) | undefined;
		let pending = false;
		let installed = 0;
		let dialogsClosed = 0;
		const host = {
			requestGuestUi: (_request: CollabUiRequestDraft, signal?: AbortSignal) => {
				const deferred = Promise.withResolvers<CollabGuestUiResult>();
				lateAnswer = deferred.resolve;
				pending = true;
				signal?.addEventListener("abort", () => {
					pending = false;
					deferred.resolve({ kind: "unavailable" });
				}, { once: true });
				return deferred.promise;
			},
		} as unknown as CollabHost;
		const guestUi = createGuestUiContext({
			host: () => host,
			opened: () => 1,
			closed: () => dialogsClosed++,
		});
		const client = { close: () => {} } as unknown as SkillshareClient;
		const service = new SkillsService({
			cwd: "/session/project",
			session: { isStreaming: false, isCompacting: false, refreshSkillsAndCommands: async () => {} },
			ui: { confirm: (title, message, options) => guestUi.confirm(title, message, { ...options, timeout: 5 }) },
			onCatalogChanged: () => {},
			createClient: async () => client,
			operations: {
				install: async (_client, options, hooks: SkillInstallHooks): Promise<InstallerSkillChange[]> => {
					expect(options.yes).toBe(false);
					if (!await hooks.confirmScripts({
						id: "@omp-console/review",
						version: "1.2.0",
						files: [{ path: "scripts/setup.ts", executable: true, size: 12, sha256: "a".repeat(64) }],
					})) throw new Error("declined");
					installed++;
					return [{ id: "@omp-console/review", to: "1.2.0", range: "^1.2.0", restored: false }];
				},
				update: async () => [],
				listInstalled: async () => [],
			},
		});

		await expect(service.install(["@omp-console/review"], false, { approvalId: "timeout-1" })).rejects.toThrow("declined");
		expect(pending).toBe(false);
		expect(dialogsClosed).toBe(1);
		lateAnswer?.({ kind: "answered", value: "Yes" });
		expect(installed).toBe(0);
	});
});
