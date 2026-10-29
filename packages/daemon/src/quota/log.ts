import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import { isWindows } from "../platform";

export class QuotaLog {
	readonly #file: string;
	#queue: Promise<unknown> = Promise.resolve();

	constructor(stateDir: string) {
		this.#file = path.join(stateDir, "quota.jsonl");
	}

	append(row: unknown): Promise<void> {
		const payload = `${JSON.stringify(row)}\n`;
		const run = this.#queue.then(async () => {
			await fs.mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
			await fs.appendFile(this.#file, payload, { encoding: "utf8", mode: 0o600 });
			if (!isWindows) await fs.chmod(this.#file, 0o600);
		});
		this.#queue = run.catch(() => undefined);
		return run;
	}

	async read(): Promise<unknown[]> {
		await this.#queue;
		let text: string;
		try {
			text = await Bun.file(this.#file).text();
		} catch (error) {
			if (isEnoent(error)) return [];
			throw error;
		}
		const rows: unknown[] = [];
		for (const line of text.split("\n")) {
			if (!line) continue;
			try {
				rows.push(JSON.parse(line));
			} catch {
				// A truncated final append after process termination is not a complete record.
			}
		}
		return rows;
	}
}
