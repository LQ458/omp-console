import { afterEach, describe, expect, it } from "bun:test";
import * as zlib from "node:zlib";
import type { SessionSummary } from "@omp-console/protocol";
import { rawHttpRequest, startTestDaemon, stopTestDaemons } from "./harness";

afterEach(stopTestDaemons);

function compressionRows(): SessionSummary[] {
	return Array.from({ length: 40 }, (_, index) => ({
		id: `compression-${index}`,
		title: `Session ${index}: ${"repeatable session title ".repeat(3)}`,
		cwd: "/workspace",
		state: "stopped",
		createdAt: index,
		lastActivityAt: index,
		agentCount: 0,
		goalActive: false,
		awaitingAnswer: false,
	}));
}

function varyTokens(value: string | string[] | undefined): string[] {
	return String(value ?? "").split(",").map(token => token.trim().toLowerCase());
}

describe("daemon API compression", () => {
	it("compresses large JSON once, preserves identity bodies, and skips small and HEAD responses", async () => {
		const daemon = await startTestDaemon({ recent: compressionRows() });
		const port = Number(new URL(daemon.url).port);
		const compressed = await rawHttpRequest(port, "/api/sessions", { "Accept-Encoding": "gzip", Cookie: daemon.cookie });
		const identity = await rawHttpRequest(port, "/api/sessions", { "Accept-Encoding": "gzip;q=0, identity;q=1", Cookie: daemon.cookie });

		expect(compressed.status).toBe(200);
		expect(compressed.headers["content-encoding"]).toBe("gzip");
		expect(varyTokens(compressed.headers.vary)).toContain("accept-encoding");
		const uncompressed = zlib.gunzipSync(new Uint8Array(compressed.body));
		expect(uncompressed.toString("utf8")).toBe(identity.body.toString("utf8"));
		expect((JSON.parse(uncompressed.toString("utf8")) as { recent: SessionSummary[] }).recent).toHaveLength(40);
		if (compressed.headers["content-length"] !== undefined) {
			expect(Number(compressed.headers["content-length"])).toBe(compressed.body.byteLength);
		}

		expect(identity.status).toBe(200);
		expect(identity.headers["content-encoding"]).toBeUndefined();
		expect(varyTokens(identity.headers.vary)).toContain("accept-encoding");

		const small = await rawHttpRequest(port, "/api/health", { "Accept-Encoding": "gzip", Cookie: daemon.cookie });
		expect(small.status).toBe(200);
		expect(small.headers["content-encoding"]).toBeUndefined();
		expect(varyTokens(small.headers.vary)).toContain("accept-encoding");

		const head = await rawHttpRequest(port, "/api/sessions", { "Accept-Encoding": "gzip", Cookie: daemon.cookie }, "HEAD");
		expect(head.headers["content-encoding"]).toBeUndefined();
		expect(head.body.byteLength).toBe(0);
	});
});
