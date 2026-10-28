// omp-sweep probe: selecting a rewind point prefills the composer with that prompt.
(async () => {
	const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
	const expected = "the guest socket sometimes stays dead after a relay redeploy — can you audit the reconnect path in relay-client.ts?";
	const sessions = await (await fetch("/api/sessions")).json();
	const id = sessions.live.find(session => session.title === "Refactor relay backoff")?.id;
	if (!id) return ["no seeded session for rewind round-trip"];
	location.hash = "#session=" + id;
	await sleep(1800);

	const input = document.querySelector(".sh-composer-input");
	if (!input) return ["composer input is missing"];
	input.focus();
	const escape = () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
	escape();
	escape();
	await sleep(350);
	const point = [...document.querySelectorAll(".rw-point")].find(row => row.textContent.includes("guest socket sometimes stays dead"));
	if (!point) return ["rewind point is missing"];
	point.click();
	await sleep(350);
	return input.value === expected ? [] : [`rewound prompt was not prefilled: ${JSON.stringify(input.value)}`];
})();
