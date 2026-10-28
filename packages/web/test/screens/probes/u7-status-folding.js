// Browser contract probe for the header status line: visible in a full desktop pane, folded in narrow panes.
// Run against the mock daemon with `omp-sweep --widths 1280,1024,393 --height 852 --themes light --probe-file test/screens/probes/u7-status-folding.js`.
(async () => {
	const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
	const sessions = await (await fetch("/api/sessions")).json();
	const sessionId = sessions.live?.find(session => session.title === "Refactor relay backoff")?.id;
	if (!sessionId) return ["missing mock session"];
	location.hash = "#session=" + encodeURIComponent(sessionId);
	await sleep(1800);
	const status = document.querySelector(".sh-deck-status");
	const visible = status !== null && getComputedStyle(status).display !== "none";
	if (innerWidth >= 1200 && !visible) return ["status segments should be visible in a wide pane"];
	if (innerWidth <= 1024 && visible) return ["status segments should fold in a narrow pane"];
	if (innerWidth >= 1200) {
		const cost = document.querySelector('[data-status-segment="cost"]');
		const value = cost?.lastElementChild;
		if (!cost || !value || getComputedStyle(cost).display === "none") return ["cost status segment missing in a wide pane"];
		if (value.scrollWidth > value.clientWidth) return ["cost status value is clipped in a wide pane"];
	}
	return [];
})()