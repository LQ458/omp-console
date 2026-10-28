const SERVICE = "omp-console-openrouter";
const ACCOUNT = "omp-console";
const ITEM_NOT_FOUND_EXIT_CODE = 44;
/** A locked or prompting Keychain must not hold daemon startup. */
const KEYCHAIN_TIMEOUT_MS = 5_000;

/**
 * Read the OpenRouter key without exposing Keychain output on stderr. Absent, unreadable or slow all mean "no key":
 * the caller then decides with the text model instead of failing to start.
 */
export async function loadOpenRouterKey(): Promise<string | undefined> {
	// The Keychain is macOS-only; elsewhere (the VPS daemon) decisions run on the text model.
	if (process.platform !== "darwin") return undefined;
	let child: ReturnType<typeof Bun.spawn>;
	try {
		child = Bun.spawn(["security", "find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"], {
			stdout: "pipe",
			stderr: "ignore",
			timeout: KEYCHAIN_TIMEOUT_MS,
		});
	} catch {
		return undefined;
	}
	const outputPromise = new Response(child.stdout as ReadableStream<Uint8Array>).text();
	const [exitCode, output] = await Promise.all([child.exited, outputPromise]);
	if (exitCode === ITEM_NOT_FOUND_EXIT_CODE || exitCode !== 0) return undefined;
	return output.trim() || undefined;
}
