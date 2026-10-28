/** Headless omp console operations for omp's Skillshare registry and installer. */
import type { InstalledSkill, SkillChange, SkillSearchHit, SkillSearchResult } from "@omp-console/protocol";
import type { SkillSearchResponse } from "@oh-my-pi/pi-wire/skillshare";
import { SkillshareClient } from "@oh-my-pi/pi-coding-agent/skillshare/client";
import {
	formatScriptApproval,
	installSkillPackages,
	listInstalledSkills,
	type InstalledSkillInfo,
	type SkillChange as InstallerSkillChange,
	type SkillInstallHooks,
	updateSkillPackages,
} from "@oh-my-pi/pi-coding-agent/skillshare/installer";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { RequestError } from "./request-error";

interface SkillsSession {
	isStreaming: boolean;
	isCompacting: boolean;
	refreshSkillsAndCommands(): Promise<void>;
}

interface SkillsOperations {
	install: typeof installSkillPackages;
	update: typeof updateSkillPackages;
	listInstalled: typeof listInstalledSkills;
}
interface SkillMutationOptions {
	approvalId?: string;
	signal?: AbortSignal;
}

const SKILL_APPROVAL_TIMEOUT_MS = 120_000;
const SKILL_APPROVAL_MARKER = "omp-console-skill-approval";

const DEFAULT_OPERATIONS: SkillsOperations = {
	install: installSkillPackages,
	update: updateSkillPackages,
	listInstalled: listInstalledSkills,
};

export interface SkillsServiceOptions {
	cwd: string;
	registryUrl?: string;
	session: SkillsSession;
	ui: Pick<ExtensionUIContext, "confirm">;
	onCatalogChanged(): void;
	createClient?: () => Promise<SkillshareClient>;
	operations?: SkillsOperations;
}

function toSearchResult(response: SkillSearchResponse): SkillSearchResult {
	const hits: SkillSearchHit[] = response.hits.map(hit => ({
		scope: hit.scope,
		name: hit.name,
		version: hit.version,
		description: hit.description ?? undefined,
		weeklyDownloads: hit.weeklyDownloads,
		updatedAt: hit.updatedAt,
		publisher: { username: hit.publisher.username },
		keywords: [...hit.keywords],
		deprecated: hit.deprecated ?? undefined,
	}));
	return { hits, page: response.page, perPage: response.perPage, total: response.total };
}

function toSkillChanges(changes: InstallerSkillChange[]): SkillChange[] {
	return changes.map(change => ({
		id: change.id,
		from: change.from,
		to: change.to,
		range: change.range,
		restored: change.restored,
	}));
}

function toInstalledSkills(skills: InstalledSkillInfo[]): InstalledSkill[] {
	return skills.map(skill => ({
		id: skill.id,
		range: skill.range,
		version: skill.version,
		scope: skill.scope,
		stored: skill.stored,
	}));
}

export class SkillsService {
	readonly #cwd: string;
	readonly #session: SkillsSession;
	readonly #ui: Pick<ExtensionUIContext, "confirm">;
	readonly #onCatalogChanged: () => void;
	readonly #createClient: () => Promise<SkillshareClient>;
	readonly #operations: SkillsOperations;

	constructor(options: SkillsServiceOptions) {
		this.#cwd = options.cwd;
		this.#session = options.session;
		this.#ui = options.ui;
		this.#onCatalogChanged = options.onCatalogChanged;
		this.#createClient =
			options.createClient ??
			(() => SkillshareClient.create(options.registryUrl ? { registryUrl: options.registryUrl } : undefined));
		this.#operations = options.operations ?? DEFAULT_OPERATIONS;
	}

	async search(query: string): Promise<SkillSearchResult> {
		const client = await this.#createClient();
		try {
			return toSearchResult(await client.search(query));
		} finally {
			client.close();
		}
	}

	async installed(): Promise<InstalledSkill[]> {
		return toInstalledSkills(await this.#operations.listInstalled(this.#cwd));
	}

	async install(
		specs: string[],
		global: boolean,
		options: SkillMutationOptions = {},
	): Promise<{ changes: SkillChange[]; warnings: string[]; installed: InstalledSkill[] }> {
		this.#requireIdle();
		const client = await this.#createClient();
		const warnings: string[] = [];
		try {
			const changes = await this.#operations.install(
				client,
				{ specs, global, yes: false, cwd: this.#cwd },
				this.#hooks(warnings, options),
			);
			await this.#refreshAfterMutation(changes);
			return {
				changes: toSkillChanges(changes),
				warnings,
				installed: await this.installed(),
			};
		} finally {
			client.close();
		}
	}

	async update(
		names: string[],
		global: boolean,
		options: SkillMutationOptions = {},
	): Promise<{ changes: SkillChange[]; warnings: string[]; installed: InstalledSkill[] }> {
		this.#requireIdle();
		const client = await this.#createClient();
		const warnings: string[] = [];
		try {
			const changes = await this.#operations.update(client, { names, global, cwd: this.#cwd }, this.#hooks(warnings, options));
			await this.#refreshAfterMutation(changes);
			return {
				changes: toSkillChanges(changes),
				warnings,
				installed: await this.installed(),
			};
		} finally {
			client.close();
		}
	}

	#hooks(warnings: string[], options: SkillMutationOptions): SkillInstallHooks {
		const marker = options.approvalId === undefined ? "" : `\n\n[${SKILL_APPROVAL_MARKER}:${options.approvalId}]`;
		return {
			warn: warning => warnings.push(warning),
			confirmScripts: request =>
				this.#ui.confirm("Install skill with scripts?", `${formatScriptApproval(request)}${marker}`, {
					timeout: SKILL_APPROVAL_TIMEOUT_MS,
					...(options.signal === undefined ? {} : { signal: options.signal }),
				}),
		};
	}

	#requireIdle(): void {
		if (this.#session.isStreaming || this.#session.isCompacting) {
			throw new RequestError("conflict", "skills can only be installed or updated while the session is idle");
		}
	}

	async #refreshAfterMutation(changes: InstallerSkillChange[]): Promise<void> {
		if (changes.length === 0) return;
		await this.#session.refreshSkillsAndCommands();
		this.#onCatalogChanged();
	}
}
