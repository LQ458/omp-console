/** Returns whether the daemon can expose omp-console computer-use tools on a host platform. */
export function computerUseSupported(platform: string): boolean {
	return platform === "darwin";
}
