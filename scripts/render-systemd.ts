import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function required(value: string | undefined, label: string): string {
	if (!value) throw new Error(`Missing ${label}`);
	return value;
}

function rejectControl(value: string): void {
	if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\n\r]/.test(value)) throw new Error("systemd values cannot contain control characters");
}

/** One ExecStart word: double-quoted; `$` is written `$$` (systemd variable syntax); backticks are not special. */
function escapeSystemd(value: string): string {
	rejectControl(value);
	return `"${value.replaceAll("\\", "\\\\").replaceAll("%", "%%").replaceAll("\"", "\\\"").replaceAll("$", "$$$$")}"`;
}

/** `WorkingDirectory=` takes the path literally (C escapes such as `\x20` are not decoded); only specifiers need `%%`. */
function escapeSystemdPath(value: string): string {
	rejectControl(value);
	return value.replaceAll("%", "%%");
}

function escapeSystemdSetting(value: string): string {
	if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\n\r]/.test(value)) throw new Error("systemd values cannot contain control characters");
	return value.replaceAll("\\", "\\\\").replaceAll("%", "%%").replaceAll(" ", "\\x20").replaceAll("\t", "\\x09").replaceAll("\"", "\\x22");
}

const args = process.argv.slice(2);
if (args.length < 7) throw new Error("Usage: render-systemd.ts <template> <output> <bun> <repo-root> <home> <path> <owner> [allow-host ...]");
const templatePath = required(args[0], "template path");
const outputPath = required(args[1], "output path");
const bunPath = required(args[2], "Bun path");
const repoRoot = required(args[3], "repository root");
const home = required(args[4], "home directory");
const inheritedPath = args[5] ?? "";
const owner = args[6] ?? "";
const allowHosts = args.slice(7);
if (owner.length > 0 && allowHosts.length === 0) throw new Error("An owner requires at least one allowed host");

const programArguments = [
	bunPath,
	path.join(repoRoot, "packages/daemon/src/main.ts"),
	"--state-dir",
	path.join(home, ".omp-console"),
	"--port",
	"7490",
	"--web-dir",
	path.join(repoRoot, "packages/web/dist"),
];
if (owner) programArguments.push("--owner", owner);
for (const host of allowHosts) programArguments.push("--allow-host", host);
const command = programArguments.map(escapeSystemd).join(" ");
const environmentPath = [inheritedPath, path.dirname(bunPath)].filter(Boolean).join(path.delimiter);
let rendered = await readFile(templatePath, "utf8");
rendered = rendered
	.replace("@EXEC_START@", () => command)
	.replaceAll("@PATH@", () => escapeSystemdSetting(environmentPath))
	.replaceAll("@WORKING_DIRECTORY@", () => escapeSystemdPath(repoRoot))
	.replaceAll("@ENV_FILE@", () => escapeSystemdSetting(path.join(home, ".omp-console", "env")));
if (/@[A-Z_]+@/.test(rendered)) throw new Error("systemd template contains an unexpanded placeholder");
await writeFile(outputPath, rendered);
