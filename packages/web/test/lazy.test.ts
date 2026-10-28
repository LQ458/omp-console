import { describe, expect, it } from "bun:test";
import { buildVersionFromIndex, LazyImportError, reloadOncePerBuild, withLazyImportRecovery } from "../src/lib/lazy";

class MemoryStorage {
	#values = new Map<string, string>();

	getItem(key: string): string | null {
		return this.#values.get(key) ?? null;
	}

	setItem(key: string, value: string): void {
		this.#values.set(key, value);
	}
}

describe("lazy chunk recovery", () => {
	it("reloads once for a build and leaves a repeated import error for the UI fallback", async () => {
		const storage = new MemoryStorage();
		let reloads = 0;
		const reload = (): void => {
			reloads++;
		};
		const failImport = async (): Promise<never> => {
			throw new Error("chunk unavailable");
		};
		const handleFailure = (): void => {
			reloadOncePerBuild("build-42", storage, reload);
		};

		const outcomes: string[] = [];
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				await withLazyImportRecovery(failImport, handleFailure);
				outcomes.push("loaded");
			} catch (error) {
				outcomes.push(error instanceof Error ? error.message : "unknown import error");
			}
		}

		expect(outcomes).toEqual(["chunk unavailable", "chunk unavailable"]);

		expect(reloads).toBe(1);
		expect(reloadOncePerBuild("build-43", storage, reload)).toBe(true);
		expect(reloads).toBe(2);
	});

	it("reads only a real build id from the fetched shell", () => {
		expect(buildVersionFromIndex('<meta name="omp-console-build-version" content="abc123" />')).toBe("abc123");
		expect(buildVersionFromIndex("<html><head><title>offline error</title></head></html>")).toBeNull();
	});

	it("keeps an unreachable chunk retryable instead of hiding the original import failure", async () => {
		let probes = 0;
		try {
			await withLazyImportRecovery(
				async () => {
					throw new Error("chunk unavailable");
				},
				() => {
					probes++;
					return "retry";
				},
			);
		} catch (error) {
			expect(error).toBeInstanceOf(LazyImportError);
			expect(error).toMatchObject({ action: "retry", message: "chunk unavailable" });
		}
		expect(probes).toBe(1);
	});
});
