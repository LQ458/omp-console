import { navigateTo } from "./shell.js";
import { normalizeDaemonUrl } from "./url.js";

const AUTO_RETRY_MS = 10_000;
const PROBE_TIMEOUT_MS = 5_000;
const $ = id => document.getElementById(id);

// The native shell passes what failed and why, so this screen never depends on the Capacitor bridge.
const params = new URLSearchParams(location.search);
const checked = normalizeDaemonUrl(params.get("url"));
const url = checked.ok ? checked.url : null;
$("target").textContent = url ?? "the daemon";
$("reason").textContent = params.get("reason") ?? "";

$("retry").addEventListener("click", () => {
	if (url) navigateTo(url);
	else location.replace("index.html");
});
$("change").addEventListener("click", () => location.replace("index.html?edit=1"));

// While this screen is up, probe an https daemon and go back in as soon as it answers. A no-cors
// fetch resolves for any HTTP answer and rejects only on network failure. Plain-http daemons
// cannot be probed from this https page (mixed content), so they retry manually.
if (url?.startsWith("https://")) {
	const timer = setInterval(async () => {
		try {
			await fetch(url, { mode: "no-cors", cache: "no-store", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
			clearInterval(timer);
			navigateTo(url);
		} catch {
			// Still unreachable.
		}
	}, AUTO_RETRY_MS);
}
