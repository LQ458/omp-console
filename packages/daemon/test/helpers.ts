import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const FAKE_WORKER = path.join(import.meta.dir, "fixtures", "fake-worker.ts");

/** Worker command running the fake worker under the current Bun with the given behaviour flags. */
export function fakeCmd(...flags: string[]): string[] {
	return [process.execPath, FAKE_WORKER, ...flags];
}

export function makeTmp(prefix = "omp-console-daemon-"): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function readJsonLines(file: string): Array<Record<string, unknown>> {
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as Record<string, unknown>);
}
