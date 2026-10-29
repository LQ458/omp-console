import type { DraftPlan } from "@omp-console/protocol";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import { parseDraftPlan, validateDraftPlanStructure } from "./runner";
import { isWindows } from "../platform";

export const PLAN_TEMPLATE_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/;

export class PlanTemplateNameError extends Error {
	constructor(name: string) {
		super(`invalid plan template name ${JSON.stringify(name)}`);
	}
}

export class PlanTemplates {
	readonly #directory: string;

	constructor(stateDir: string) {
		this.#directory = path.join(stateDir, "plan-templates");
	}

	async save(name: string, input: DraftPlan): Promise<DraftPlan> {
		if (!PLAN_TEMPLATE_NAME.test(name)) throw new PlanTemplateNameError(name);
		const plan = parseDraftPlan(input);
		if (!plan) throw new Error("body must be a draft plan");
		validateDraftPlanStructure(plan);
		const template: DraftPlan = { ...plan, name };
		await fs.mkdir(this.#directory, { recursive: true, mode: 0o700 });

		const file = path.join(this.#directory, `${name}.json`);
		const temporary = `${file}.${crypto.randomUUID()}.tmp`;
		try {
			await fs.writeFile(temporary, `${JSON.stringify(template)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
			if (!isWindows) await fs.chmod(temporary, 0o600);
			await fs.rename(temporary, file);
			if (!isWindows) await fs.chmod(file, 0o600);
		} catch (error) {
			await fs.rm(temporary, { force: true }).catch(() => {});
			throw error;
		}
		return template;
	}

	async list(): Promise<DraftPlan[]> {
		let entries: Dirent[];
		try {
			entries = await fs.readdir(this.#directory, { withFileTypes: true });
		} catch (error) {
			if (isEnoent(error)) return [];
			throw error;
		}

		const names = entries
			.filter(entry => entry.isFile() && entry.name.endsWith(".json"))
			.map(entry => entry.name.slice(0, -5))
			.filter(name => PLAN_TEMPLATE_NAME.test(name))
			.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
		const templates: DraftPlan[] = [];
		for (const name of names) {
			const file = path.join(this.#directory, `${name}.json`);
			const parsed = parseDraftPlan(JSON.parse(await Bun.file(file).text()));
			if (!parsed) throw new Error(`plan template ${JSON.stringify(name)} is invalid`);
			validateDraftPlanStructure(parsed);
			parsed.name = name;
			if (!isWindows) await fs.chmod(file, 0o600);
			templates.push(parsed);
		}
		return templates;
	}
}
