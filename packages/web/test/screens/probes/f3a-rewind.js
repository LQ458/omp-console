// omp-sweep probe: double Escape opens the rewind picker with current-branch user messages.
(async () => {
	const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
	const sessions = await (await fetch("/api/sessions")).json();
	const id = sessions.live.find(session => session.title === "Refactor relay backoff")?.id;
	if (!id) return ["no seeded session for rewind probe"];
	location.hash = "#session=" + id;
	await sleep(1800);

	const input = document.querySelector(".sh-composer-input");
	if (!input) return ["composer input is missing"];
	input.focus();
	const escape = () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
	escape();
	escape();
	await sleep(350);

	const problems = [];
	const point = [...document.querySelectorAll(".rw-point")].find(row => row.textContent.includes("guest socket sometimes stays dead"));
	const dialog = document.querySelector('.dk-sheet[aria-label="Rewind to a message"]');
	if (!point || !dialog) {
		problems.push("rewind sheet does not show the current-branch prompt");
	} else {
		point.scrollIntoView({ block: "center" });
		await sleep(50);
		const bounds = point.getBoundingClientRect();
		if (bounds.height === 0 || bounds.top < 0 || bounds.bottom > innerHeight) {
			problems.push("current-branch rewind prompt is not visible in the sheet");
		}
	}
	return problems;
})();
