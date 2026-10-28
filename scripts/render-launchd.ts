import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function required(value: string | undefined, label: string): string {
	if (!value) throw new Error(`Missing ${label}`);
	return value;
}

function escapeXml(value: string): string {
	if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new Error("LaunchAgent values cannot contain XML control characters");
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

const args = process.argv.slice(2);
if (args.length < 7) throw new Error("Usage: render-launchd.ts <template> <output> <bun> <repo-root> <home> <path> <owner> [allow-host ...]");
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
	"/bin/bash",
	path.join(repoRoot, "scripts/launchd-wrapper.sh"),
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
const argumentXml = programArguments.map(argument => `		<string>${escapeXml(argument)}</string>`).join("\n");
const environmentPath = [inheritedPath, path.dirname(bunPath)].filter(Boolean).join(path.delimiter);
let rendered = await readFile(templatePath, "utf8");
rendered = rendered
	.replace("@PROGRAM_ARGUMENTS@", argumentXml)
	.replaceAll("@PATH@", escapeXml(environmentPath))
	.replaceAll("@LOG_DIR@", escapeXml(path.join(home, "Library/Logs/omp-console")))
	.replaceAll("@REPO_ROOT@", escapeXml(repoRoot));
if (/@[A-Z_]+@/.test(rendered)) throw new Error("LaunchAgent template contains an unexpanded placeholder");
await writeFile(outputPath, rendered);
