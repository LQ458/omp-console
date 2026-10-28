export function deviceNameFromUserAgent(userAgent: string): string {
	const platform = /iPhone|iPad|iPod/i.test(userAgent)
		? "iOS"
		: /Android/i.test(userAgent)
			? "Android"
			: /Macintosh|Mac OS X/i.test(userAgent)
				? "macOS"
				: /Windows/i.test(userAgent)
					? "Windows"
					: /Linux/i.test(userAgent)
						? "Linux"
						: undefined;
	const browser = /Edg(?:e|A|iOS)?\//i.test(userAgent)
		? "Edge"
		: /OPR\//i.test(userAgent)
			? "Opera"
			: /Firefox\//i.test(userAgent)
				? "Firefox"
				: /(?:Chrome|CriOS)\//i.test(userAgent)
					? "Chrome"
					: /Version\//i.test(userAgent) && /Safari\//i.test(userAgent)
						? "Safari"
						: undefined;
	if (browser && platform) return `${browser} on ${platform}`;
	if (platform) return `Web browser on ${platform}`;
	return "Web browser";
}

export function pairingErrorMessage(status: number, message: string): string {
	if (status === 429) return "Too many attempts. Wait a minute before trying again.";
	if (status === 410) return "This code expired or was already used. Request a fresh code from the daemon.";
	if (status === 400) return "That code is incorrect. Check the daemon's current code and try again.";
	return message;
}
