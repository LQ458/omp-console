// Thin wrapper over the Capacitor native bridge for the local launcher pages.
// The pages run at https://localhost inside the app, where `window.Capacitor` is injected.
// Outside the app (a desktop browser, for layout work) it falls back to localStorage.

export const URL_KEY = "daemonUrl";
const PERM_ASKED_KEY = "notificationPermissionAsked";

const cap = () => (typeof window !== "undefined" ? window.Capacitor : undefined);
const native = () => Boolean(cap()?.isNativePlatform?.());

async function prefGet(key) {
	if (native()) {
		const { value } = await cap().nativePromise("Preferences", "get", { key });
		return value ?? null;
	}
	return window.localStorage.getItem(key);
}

async function prefSet(key, value) {
	if (native()) {
		await cap().nativePromise("Preferences", "set", { key, value });
		return;
	}
	window.localStorage.setItem(key, value);
}

export const getStoredUrl = () => prefGet(URL_KEY);
export const setStoredUrl = url => prefSet(URL_KEY, url);

/**
 * Ask for POST_NOTIFICATIONS once, on first run. Android stops showing the dialog after
 * repeated denials, so we never re-ask; the user can enable it in system settings.
 */
export async function requestNotificationPermissionOnce() {
	if (!native() || (await prefGet(PERM_ASKED_KEY)) === "1") return;
	await prefSet(PERM_ASKED_KEY, "1");
	try {
		await cap().nativePromise("LocalNotifications", "requestPermissions", {});
	} catch {
		// Denied or unavailable: notifications are optional.
	}
}

export function navigateTo(url) {
	window.location.replace(url);
}
