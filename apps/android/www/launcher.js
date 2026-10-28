import { getStoredUrl, navigateTo, requestNotificationPermissionOnce, setStoredUrl } from "./shell.js";
import { normalizeDaemonUrl } from "./url.js";

const $ = id => document.getElementById(id);
const editMode = new URLSearchParams(location.search).get("edit") === "1";

function showSetup(prefill) {
	$("connecting").hidden = true;
	$("setup").hidden = false;
	const input = $("url");
	if (prefill) input.value = prefill;
	input.focus();
}

$("form").addEventListener("submit", async event => {
	event.preventDefault();
	const result = normalizeDaemonUrl($("url").value);
	if (!result.ok) {
		$("error").textContent = result.error;
		return;
	}
	$("error").textContent = "";
	$("connect").disabled = true;
	await setStoredUrl(result.url);
	await permissionPrompt;
	navigateTo(result.url);
});

// First run only; resolves once the user answers, so navigation never hides the system dialog.
const permissionPrompt = requestNotificationPermissionOnce();

const stored = await getStoredUrl();
if (stored && !editMode) {
	$("host").textContent = new URL(stored).host;
	$("connecting").hidden = false;
	await permissionPrompt;
	navigateTo(stored);
} else {
	showSetup(stored);
}
