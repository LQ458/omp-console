import type { AgendaHubConfig } from "./ports";

export const BOARD_IO_TIMEOUT_MS = 35_000;

export async function runBoardIo(hub: AgendaHubConfig, args: readonly string[]): Promise<string> {
	const child = Bun.spawn([hub.python, ...args], {
		cwd: hub.cwd,
		env: { ...process.env, ...hub.env },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "ignore",
		signal: AbortSignal.timeout(BOARD_IO_TIMEOUT_MS),
	});
	const [exitCode, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
	if (exitCode !== 0) throw new Error("tasks-hub board_io command failed");
	return output;
}
