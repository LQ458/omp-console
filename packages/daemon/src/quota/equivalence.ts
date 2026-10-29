import type { EquivalenceTable } from "@omp-console/protocol";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import { isWindows } from "../platform";

export const QUOTA_TIERS = ["judgment", "build", "simple"] as const;
export type QuotaTier = (typeof QUOTA_TIERS)[number];

export const QUOTA_ROLE_GROUPS: Readonly<Record<QuotaTier, readonly string[]>> = {
	judgment: ["judge", "critic", "plan", "escalate", "slow"],
	build: ["default", "task", "worker", "research", "explore"],
	simple: ["lookup", "factcheck", "locate", "fetch", "inventory", "mechanical", "verify", "digest", "smol"],
};

const TIER_RANK: Readonly<Record<QuotaTier, number>> = { simple: 0, build: 1, judgment: 2 };
const ROLE_TIER = new Map<string, QuotaTier>(
	Object.entries(QUOTA_ROLE_GROUPS).flatMap(([tier, roles]) => roles.map(role => [role, tier as QuotaTier] as const)),
);

export class EquivalenceValidationError extends Error {
	override readonly name = "EquivalenceValidationError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown, maximum: number): value is string {
	return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
}

function selectorFromRoles(modelRoles: Readonly<Record<string, string>>, roles: readonly string[]): string[] {
	const seen = new Set<string>();
	const models: string[] = [];
	for (const role of roles) {
		const selector = modelRoles[role]?.trim();
		if (selector && !seen.has(selector)) {
			seen.add(selector);
			models.push(selector);
		}
	}
	return models;
}

/** Seed explicit substitutions only from configured omp modelRoles; judgment roles intentionally have none. */
export function defaultEquivalenceTable(modelRoles: Readonly<Record<string, string>>): EquivalenceTable {
	return {
		tiers: QUOTA_TIERS.map(tier => ({
			tier,
			roles: [...QUOTA_ROLE_GROUPS[tier]],
			models: tier === "judgment" ? [] : selectorFromRoles(modelRoles, QUOTA_ROLE_GROUPS[tier]),
		})),
	};
}

export function validateEquivalenceTable(raw: unknown): EquivalenceTable {
	if (!isRecord(raw) || Object.keys(raw).some(key => key !== "tiers") || !Array.isArray(raw.tiers)) {
		throw new EquivalenceValidationError("equivalence must contain a tiers array");
	}
	const seenTiers = new Set<string>();
	const seenRoles = new Map<string, QuotaTier>();
	const tiers: EquivalenceTable["tiers"] = [];
	for (let index = 0; index < raw.tiers.length; index++) {
		const tier = raw.tiers[index];
		if (!isRecord(tier) || Object.keys(tier).some(key => !["tier", "roles", "models"].includes(key))) {
			throw new EquivalenceValidationError(`tiers[${index}] must contain only tier, roles and models`);
		}
		if (!isText(tier.tier, 32) || !QUOTA_TIERS.includes(tier.tier as QuotaTier)) {
			throw new EquivalenceValidationError(`tiers[${index}].tier must be judgment, build or simple`);
		}
		const tierName = tier.tier as QuotaTier;
		if (seenTiers.has(tierName)) throw new EquivalenceValidationError(`duplicate tier ${tierName}`);
		seenTiers.add(tierName);
		if (!Array.isArray(tier.roles) || tier.roles.length === 0 || tier.roles.length > 128) {
			throw new EquivalenceValidationError(`tiers[${index}].roles must contain 1 to 128 roles`);
		}
		if (!Array.isArray(tier.models) || tier.models.length > 128) {
			throw new EquivalenceValidationError(`tiers[${index}].models must contain at most 128 selectors`);
		}
		const roles: string[] = [];
		for (const role of tier.roles) {
			if (!isText(role, 64)) throw new EquivalenceValidationError(`tiers[${index}] has an invalid role`);
			if (seenRoles.has(role)) throw new EquivalenceValidationError(`role ${role} appears in more than one tier`);
			const fixedTier = ROLE_TIER.get(role);
			if (fixedTier && fixedTier !== tierName) {
				throw new EquivalenceValidationError(`role ${role} must remain in the ${fixedTier} tier`);
			}
			seenRoles.set(role, tierName);
			roles.push(role);
		}
		const models: string[] = [];
		const seenModels = new Set<string>();
		for (const model of tier.models) {
			if (!isText(model, 256)) throw new EquivalenceValidationError(`tiers[${index}] has an invalid model selector`);
			if (seenModels.has(model)) throw new EquivalenceValidationError(`duplicate model selector ${model}`);
			seenModels.add(model);
			models.push(model);
		}
		tiers.push({ tier: tierName, roles, models });
	}
	for (const role of QUOTA_ROLE_GROUPS.judgment) {
		const tier = seenRoles.get(role);
		if (tier !== undefined && tier !== "judgment") throw new EquivalenceValidationError(`judgment role ${role} must remain in the judgment tier`);
	}
	return { tiers };
}

export function substitutesForRole(
	table: EquivalenceTable,
	role: string,
	currentModel: string,
	providerFamily: (selector: string) => string | undefined,
): string[] {
	const currentTier = table.tiers.find(entry => entry.roles.includes(role));
	if (!currentTier || currentTier.tier === "judgment" || ROLE_TIER.get(role) === "judgment") return [];
	const family = providerFamily(currentModel);
	if (!family) return [];
	const candidates: string[] = [];
	if (currentTier.tier === "build") {
		const higherTiers = table.tiers
			.filter(entry => TIER_RANK[entry.tier as QuotaTier] > TIER_RANK[currentTier.tier as QuotaTier])
			.sort((a, b) => TIER_RANK[b.tier as QuotaTier] - TIER_RANK[a.tier as QuotaTier]);
		for (const entry of higherTiers) candidates.push(...entry.models);
	}
	candidates.push(...currentTier.models.filter(selector => selector !== currentModel));
	return [...new Set(candidates)].filter(selector => selector !== currentModel && providerFamily(selector) === family);
}

export class EquivalenceStore {
	readonly #file: string;

	constructor(stateDir: string) {
		this.#file = path.join(stateDir, "quota-equivalence.json");
	}

	async load(modelRoles: Readonly<Record<string, string>>): Promise<EquivalenceTable> {
		let raw: unknown;
		try {
			raw = JSON.parse(await Bun.file(this.#file).text());
		} catch (error) {
			if (isEnoent(error)) return defaultEquivalenceTable(modelRoles);
			throw error;
		}
		return validateEquivalenceTable(raw);
	}

	async save(raw: unknown): Promise<EquivalenceTable> {
		const table = validateEquivalenceTable(raw);
		await fs.mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
		const temporary = `${this.#file}.${crypto.randomUUID()}.tmp`;
		try {
			await fs.writeFile(temporary, `${JSON.stringify(table)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
			if (!isWindows) await fs.chmod(temporary, 0o600);
			await fs.rename(temporary, this.#file);
			if (!isWindows) await fs.chmod(this.#file, 0o600);
		} catch (error) {
			await fs.rm(temporary, { force: true }).catch(() => {});
			throw error;
		}
		return table;
	}
}
