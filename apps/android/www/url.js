// Daemon URL validation. Pure, no DOM, so `node --test` can exercise it.
// Mirrored by android/app/src/main/java/dev/ompconsole/mobile/DaemonUrl.java, which re-validates the
// stored value before the native bridge trusts an origin. Keep both in sync.

/** True for hosts where plain http is acceptable: localhost and private/loopback/link-local IPv4. */
export function isPlainHttpHost(hostname) {
	const host = hostname.toLowerCase();
	if (host === "localhost" || host.endsWith(".localhost") || host === "[::1]") return true;
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (!m) return false;
	const o = m.slice(1).map(Number);
	if (o.some(n => n > 255)) return false;
	const [a, b] = o;
	return (
		a === 127 ||
		a === 10 ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 169 && b === 254)
	);
}

/**
 * Normalise what the user typed.
 * Returns `{ ok: true, url }` (scheme://host[:port]/path, no query or fragment) or `{ ok: false, error }`.
 * A bare host gets `https://`. Plain `http://` is limited to `isPlainHttpHost` hosts.
 */
export function normalizeDaemonUrl(input) {
	const raw = String(input ?? "").trim();
	if (!raw) return { ok: false, error: "Enter the daemon URL." };
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
	let parsed;
	try {
		parsed = new URL(withScheme);
	} catch {
		return { ok: false, error: "That is not a valid URL." };
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		return { ok: false, error: "Only https:// URLs are supported." };
	}
	if (parsed.username || parsed.password) {
		return { ok: false, error: "Do not put credentials in the URL." };
	}
	if (!parsed.hostname) return { ok: false, error: "The URL has no host." };
	if (parsed.protocol === "http:" && !isPlainHttpHost(parsed.hostname)) {
		return {
			ok: false,
			error: "Plain http:// is only allowed for localhost and LAN addresses. Use the https:// tailnet URL.",
		};
	}
	return { ok: true, url: `${parsed.origin}${parsed.pathname}` };
}
