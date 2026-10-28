/** Copies text to the clipboard; falls back to a hidden textarea where the async API is unavailable (non-secure origins). */
export async function copyText(text: string): Promise<boolean> {
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		// fall through to the legacy path
	}
	const area = document.createElement("textarea");
	area.value = text;
	area.setAttribute("readonly", "");
	area.style.position = "fixed";
	area.style.opacity = "0";
	document.body.appendChild(area);
	area.select();
	try {
		return document.execCommand("copy");
	} catch {
		return false;
	} finally {
		area.remove();
	}
}
