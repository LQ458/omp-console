import { findExecutable, isWindows } from "../src/platform";

const executable = findExecutable("tsgo");
if (executable === undefined) {
	console.error("tsgo executable not found");
	process.exitCode = 1;
} else {
	const args = ["-p", "tsconfig.json", "--noEmit", "--pretty", "false"];
	const command = isWindows && /\.(?:cmd|bat)$/i.test(executable)
		? ["cmd.exe", "/d", "/s", "/c", `""${executable}" ${args.join(" ")}"`]
		: [executable, ...args];
	const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
	const output = `${result.stdout.toString("utf8")}\n${result.stderr.toString("utf8")}`;
	const sourceDiagnostics = output.split(/\r?\n/).filter(line => /^(?:src|test)[\\/]/.test(line));

	if (sourceDiagnostics.length > 0) {
		process.stdout.write(`${sourceDiagnostics.join("\n")}\n`);
		process.exitCode = 1;
	}
}
