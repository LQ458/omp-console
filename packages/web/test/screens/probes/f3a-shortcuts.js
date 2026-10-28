// omp-sweep probe: the keyboard sheet includes the deck-only pause-goal default.
(async () => {
	const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
	const sessions = await (await fetch("/api/sessions")).json();
	const id = sessions.live.find(session => session.title === "Refactor relay backoff")?.id;
	if (!id) return ["no seeded session for shortcuts probe"];
	location.hash = "#session=" + id;
	await sleep(1800);

	const problems = [];
	const button = document.querySelector('button[aria-label="keyboard shortcuts"]');
	if (!button) return ["keyboard shortcuts button is missing"];
	button.click();
	await sleep(300);
	const pause = [...document.querySelectorAll(".dk-keybinding")].find(row => row.querySelector("dt")?.textContent === "Pause goal");
	const dialog = document.querySelector('.dk-sheet[aria-label="Keyboard shortcuts"]');
	if (!pause || !dialog) {
		problems.push("shortcuts sheet does not show Pause goal");
	} else {
		pause.scrollIntoView({ block: "center" });
		await sleep(50);
		const bounds = pause.getBoundingClientRect();
		if (!pause.querySelector("dd")?.textContent?.includes("alt+shift+g") || bounds.height === 0 || bounds.top < 0 || bounds.bottom > innerHeight) {
			problems.push("Pause goal on alt+shift+g is not visible in the shortcuts sheet");
		}
	}
	return problems;
})();
