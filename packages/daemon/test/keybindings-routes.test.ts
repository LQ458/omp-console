import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { KeybindingsResponse } from "@omp-console/protocol";
import { createKeybindingsRoutes } from "../src/keybindings/routes";
import { createKeybindingsPorts } from "../src/keybindings/ports";

describe("keybindings route", () => {
	test("returns omp defaults and agent-dir overrides with the double-Escape setting", async () => {
		const previousConfigDir = process.env.PI_CONFIG_DIR;
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "deck-keybindings-"));
		const agentDir = path.join(root, "agent");
		const configDirName = `.omp-console-test-${path.basename(root)}`;
		fs.mkdirSync(agentDir, { recursive: true });
		process.env.PI_CONFIG_DIR = configDirName;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			const handler = createKeybindingsRoutes(createKeybindingsPorts(agentDir));
			const url = new URL("http://daemon/api/keybindings");
			const get = () => handler(new Request(url.href), url);
			const defaults = await get();
			expect(defaults?.status).toBe(200);
			const defaultValue = (await defaults?.json()) as KeybindingsResponse;
			expect(defaultValue.bindings["app.interrupt"]).toEqual(["escape"]);
			expect(defaultValue.bindings["app.model.cycleForward"]).toEqual(["ctrl+p"]);
			expect(defaultValue.doubleEscapeAction).toBe("rewind");

			fs.writeFileSync(path.join(agentDir, "keybindings.yml"), "app.interrupt: alt+shift+x\napp.model.cycleForward: ctrl+q\n");
			fs.writeFileSync(path.join(agentDir, "config.yml"), "doubleEscapeAction: tree\n");
			const overridden = await get();
			expect(overridden?.status).toBe(200);
			const overrideValue = (await overridden?.json()) as KeybindingsResponse;
			expect(overrideValue.bindings["app.interrupt"]).toEqual(["alt+shift+x"]);
			expect(overrideValue.bindings["app.model.cycleForward"]).toEqual(["ctrl+q"]);
			expect(overrideValue.bindings["app.thinking.cycle"]).toEqual(["shift+tab"]);
			expect(overrideValue.doubleEscapeAction).toBe("tree");

			expect(await handler(new Request("http://daemon/api/other"), new URL("http://daemon/api/other"))).toBeUndefined();
			const method = await handler(new Request(url.href, { method: "POST" }), url);
			expect(method?.status).toBe(405);
		} finally {
			if (previousConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
			else process.env.PI_CONFIG_DIR = previousConfigDir;
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(path.join(os.homedir(), configDirName), { recursive: true, force: true });
		}
	});
});
