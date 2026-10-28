import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ProfilerSession } from "@oh-my-pi/pi-coding-agent/debug/profiler";
import * as profiler from "@oh-my-pi/pi-coding-agent/debug/profiler";
import * as remoteDebugger from "@oh-my-pi/pi-coding-agent/debug/remote-debugger";
import { resolveRawSseDebugBuffer } from "@oh-my-pi/pi-tui/apps/debug/raw-sse-buffer";
import { DebugDiagnosticsService } from "../src/debug-diagnostics";

afterEach(() => vi.restoreAllMocks());

describe("debug diagnostics", () => {
	it("shows the newest raw SSE records and truncates only at a line boundary", async () => {
		const session = {} as AgentSession;
		const buffer = resolveRawSseDebugBuffer(session);
		for (let sequence = 0; sequence < 1_000; sequence += 1) {
			buffer.recordEvent({
				event: "fixture",
				data: `sequence-${String(sequence).padStart(4, "0")}`,
				raw: [`data: sequence-${String(sequence).padStart(4, "0")} ${"x".repeat(300)}`],
			});
		}

		const snapshot = await new DebugDiagnosticsService(session).run("raw-sse", undefined);
		const text = snapshot.text ?? "";
		const visibleLines = text.slice(text.indexOf("\n") + 1).split("\n").filter(Boolean);
		expect(text).toContain("data: sequence-0999");
		expect(text).not.toContain("data: sequence-0000");
		expect(visibleLines.every(line => line.startsWith("data: sequence-"))).toBe(true);
	});

	it("serializes profiler starts and stops a profiler that resolves during close", async () => {
		const pendingProfile = Promise.withResolvers<ProfilerSession>();
		const stop = vi.fn(async () => ({ data: "{}", markdown: "profile" }));
		const start = vi.spyOn(profiler, "startCpuProfile").mockImplementation(() => pendingProfile.promise);
		const service = new DebugDiagnosticsService({} as AgentSession);
		let firstError: unknown;
		let secondError: unknown;
		const first = service.run("performance-start", undefined).catch(cause => { firstError = cause; });
		const second = service.run("performance-start", undefined).catch(cause => { secondError = cause; });
		const closing = service.close();
		pendingProfile.resolve({ stop });

		await Promise.all([first, second, closing]);
		expect(start).toHaveBeenCalledTimes(1);
		expect(firstError).toBeDefined();
		expect(secondError).toMatchObject({ code: "conflict" });
		expect(stop).toHaveBeenCalledTimes(1);
	});

	it("requires explicit confirmation before starting the unauthenticated local inspector", async () => {
		const get = vi.spyOn(remoteDebugger, "getRemoteDebugger").mockReturnValue(null);
		const start = vi.spyOn(remoteDebugger, "startRemoteDebuggerServer").mockResolvedValue({ host: "127.0.0.1", port: 9229 });
		const service = new DebugDiagnosticsService({} as AgentSession);

		const confirmation = await service.run("remote-debugger", undefined);
		expect(confirmation.confirmationRequired).toBe(true);
		expect(confirmation.text).toContain("unauthenticated");
		expect(start).not.toHaveBeenCalled();

		const started = await service.run("remote-debugger", true);
		expect(start).toHaveBeenCalledTimes(1);
		expect(get).toHaveBeenCalledTimes(2);
		expect(started.text).toContain("any local process");
		expect(started.text).toContain("execute code");
		expect(started.remoteDebugger).toMatchObject({ host: "127.0.0.1", port: 9229, stopSupported: false });
	});
});
