import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { makeTmp } from "./helpers";

const repoRoot = path.resolve(import.meta.dir, "../../..");

async function render(script: string, template: string, home: string): Promise<string> {
	const output = path.join(makeTmp("omp-console-render-"), "rendered");
	const result = Bun.spawnSync(
		[
			process.execPath,
			path.join(repoRoot, "scripts", script),
			path.join(repoRoot, template),
			output,
			process.execPath,
			repoRoot,
			home,
			"/usr/bin:/bin",
			"",
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (result.exitCode !== 0) throw new Error(result.stderr.toString("utf8"));
	return fs.readFile(output, "utf8");
}

describe("service environment rendering", () => {
	it.skipIf(process.platform === "win32")("renders systemd's optional environment file at the user's state directory (systemd-only)", async () => {
		const home = path.join(os.tmpdir(), "omp console user");
		const unit = await render("render-systemd.ts", "ops/systemd/omp-console.service.template", home);
		expect(unit).toContain(`EnvironmentFile=-${home.replaceAll(" ", "\\x20")}/.omp-console/env`);
		expect(unit).toContain("Environment=OMP_CONSOLE_SUPERVISED=1");
	});

	it.skipIf(process.platform === "win32")("starts launchd through the wrapper that validates and loads the env file (launchd-only)", async () => {
		const plist = await render("render-launchd.ts", "ops/launchd/dev.ompconsole.daemon.plist.template", os.tmpdir());
		const wrapper = path.join(repoRoot, "scripts/launchd-wrapper.sh");
		const wrapperArgument = `<string>${wrapper}</string>`;
		expect(plist).toContain("<string>/bin/bash</string>");
		expect(plist).toContain(wrapperArgument);
		expect(plist.indexOf(wrapperArgument)).toBeLessThan(plist.indexOf(`<string>${process.execPath}</string>`));
		const home = makeTmp("omp-console-launchd-env-home-");
		const stateDir = path.join(home, ".omp-console");
		await fs.mkdir(stateDir, { recursive: true });
		const envFile = path.join(stateDir, "env");
		await fs.writeFile(envFile, "PI_CODING_AGENT_DIR=/tmp/agent with $ signs\nPROVIDER_API_KEY=literal $ value=with spaces\n", { mode: 0o600 });
		await fs.chmod(envFile, 0o600);
		const fakeBun = path.join(home, "fake-bun.sh");
		await fs.writeFile(fakeBun, "#!/bin/sh\nprintf '%s\\n' \"$PI_CODING_AGENT_DIR\" \"$PROVIDER_API_KEY\"\n", { mode: 0o755 });
		await fs.chmod(fakeBun, 0o755);
		const result = Bun.spawnSync(
			["/bin/bash", path.join(repoRoot, "scripts/launchd-wrapper.sh"), fakeBun, "daemon.ts"],
			{ env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" },
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString("utf8")).toBe("/tmp/agent with $ signs\nliteral $ value=with spaces\n");
	});
});
