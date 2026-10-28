import * as fs from "node:fs/promises";
import * as path from "node:path";
import { widgetFrameResponse } from "../../daemon/src/widget-frame";
import { startMockDaemon } from "../dev/mock-daemon";
import harness from "../test/motion-harness.html";

interface Options {
	out: string;
	phase: "before" | "after";
	repeats: number;
}

function parseOptions(args: string[]): Options {
	let out: string | undefined;
	let phase: Options["phase"] = "before";
	let repeats = 5;
	for (let index = 0; index < args.length; index++) {
		const value = args[index + 1];
		if (value === undefined) throw new Error(`missing value for ${args[index]}`);
		switch (args[index]) {
			case "--out":
				out = value;
				index++;
				break;
			case "--phase":
				if (value !== "before" && value !== "after") throw new Error(`invalid phase: ${value}`);
				phase = value;
				index++;
				break;
			case "--repeats":
				repeats = Number(value);
				if (!Number.isInteger(repeats) || repeats < 5) throw new Error("--repeats must be an integer of at least 5");
				index++;
				break;
			default:
				throw new Error(`unknown option: ${args[index]}`);
		}
	}
	if (out === undefined) throw new Error("--out is required");
	return { out: path.resolve(out), phase, repeats };
}

async function main(): Promise<void> {
	const options = parseOptions(Bun.argv.slice(2));
	if (Bun.env.OMP_CONSOLE_COMPUTER_USE !== "0") throw new Error("export OMP_CONSOLE_COMPUTER_USE=0 before running transition scenarios");
	const port = Number(Bun.env.OMP_CONSOLE_SCENARIO_PORT_BASE ?? "7670");
	if (!Number.isInteger(port) || port < 7620 || port > 7696) throw new Error("OMP_CONSOLE_SCENARIO_PORT_BASE must be in 7620..7696");

	const dist = path.resolve(import.meta.dir, "../dist");
	if (!(await Bun.file(path.join(dist, "index.html")).exists())) throw new Error("web assets are missing; run `bun run build` first");
	await fs.mkdir(options.out, { recursive: true });

	const daemon = await startMockDaemon({ port, dist, seed: true });
	let stopHarness: (() => Promise<void>) | undefined;
	try {
		const harnessServer = Bun.serve({
			port: port + 1,
			development: true,
			routes: {
				"/": harness,
				"/widget-frame.html": () => widgetFrameResponse(),
			},
			fetch: () => new Response("not found", { status: 404 }),
		});
		stopHarness = () => harnessServer.stop(true);
		const sessionIds = daemon.liveIds().slice(0, 2);
		if (sessionIds.length !== 2) throw new Error(`expected two seeded sessions, found ${sessionIds.length}`);

		const child = Bun.spawn(
			[
				"uv",
				"run",
				"--no-project",
				"--with",
				"playwright==1.60.0",
				"python",
				path.join(import.meta.dir, "transitions.py"),
				"--daemon-url",
				daemon.url,
				"--harness-url",
				String(harnessServer.url),
				"--session-ids",
				sessionIds.join(","),
				"--out",
				options.out,
				"--phase",
				options.phase,
				"--repeats",
				String(options.repeats),
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (stdout !== "") console.log(stdout.trimEnd());
		if (stderr !== "") console.error(stderr.trimEnd());
		if (exitCode !== 0) throw new Error(`transition browser run exited ${exitCode}`);
	} finally {
		if (stopHarness !== undefined) await stopHarness();
		await daemon.stop();
	}
}

await main();
