const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH = /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/;

/** Whether a path uses drive-letter or UNC Windows syntax. */
export function isWindowsPath(path: string): boolean {
	return WINDOWS_DRIVE_PATH.test(path) || WINDOWS_UNC_PATH.test(path);
}

function normalizeWindowsSeparators(path: string): string {
	const slashes = path.replaceAll("\\", "/");
	const uncPrefix = slashes.startsWith("//") ? "//" : "";
	return `${uncPrefix}${slashes.slice(uncPrefix.length).replace(/\/+/g, "/")}`.toLowerCase();
}

/** The final component; POSIX backslashes remain filename characters. */
export function basename(path: string): string {
	const windows = isWindowsPath(path);
	if (windows && /^[A-Za-z]:[\\/]+$/.test(path)) return "";
	const trimmed = path.replace(windows ? /[\\/]+$/ : /\/+$/, "");
	const separator = windows ? Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) : trimmed.lastIndexOf("/");
	return trimmed.slice(separator + 1);
}

/** Whether a path is absolute in POSIX or Windows syntax. */
export function isAbsolutePath(path: string): boolean {
	return path.startsWith("/") || isWindowsPath(path);
}

/** Comparison key: Windows drive/UNC paths ignore case and separator style; POSIX paths are unchanged. */
export function pathKey(path: string): string {
	return isWindowsPath(path) ? normalizeWindowsSeparators(path) : path;
}

function trimTrailingSeparators(path: string): string {
	if (path === "/" || /^[a-z]:\/$/i.test(path)) return path;
	return path.replace(/\/+$/, "");
}

/** True when `child` equals `root` or descends from it at a path-component boundary. */
export function isInside(root: string, child: string): boolean {
	const rootKey = trimTrailingSeparators(pathKey(root));
	const childKey = trimTrailingSeparators(pathKey(child));
	return childKey === rootKey || childKey.startsWith(rootKey.endsWith("/") ? rootKey : `${rootKey}/`);
}

/** Replace a conventional POSIX or Windows user-home prefix with `~`, preserving the remaining separators. */
export function abbreviateHome(path: string): string {
	const posixHome = /^\/(?:Users|home)\/[^/]+(?=\/|$)/.exec(path);
	if (posixHome !== null) return `~${path.slice(posixHome[0].length)}`;

	const windowsHome = /^[A-Za-z]:[\\/]Users[\\/][^\\/]+/i.exec(path);
	return windowsHome === null ? path : `~${path.slice(windowsHome[0].length)}`;
}

/** Convert a local or UNC file URL to its native path. Non-file and malformed URLs return null. */
export function fileUrlToPath(value: string): string | null {
	try {
		const url = new URL(value);
		if (url.protocol !== "file:") return null;
		const pathname = decodeURIComponent(url.pathname);
		if (url.hostname !== "" && url.hostname !== "localhost") {
			return `\\\\${url.hostname}${pathname.replaceAll("/", "\\")}`;
		}
		if (/^\/[A-Za-z]:[\\/]/.test(pathname)) return pathname.slice(1).replaceAll("/", "\\");
		return pathname;
	} catch {
		return null;
	}
}
