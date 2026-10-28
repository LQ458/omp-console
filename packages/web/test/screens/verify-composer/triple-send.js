// omp-sweep regression probe: three same-task Send clicks must deliver one composer draft.
(async () => {
	const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
	const problems = [];
	const sessions = await (await fetch("/api/sessions")).json();
	const id = sessions.live.find(session => session.title === "Refactor relay backoff")?.id;
	if (!id) return ["no seeded session for composer test"];
	location.hash = "#session=" + id;
	await sleep(1800);

	const input = document.querySelector(".sh-composer-input");
	const send = document.querySelector('button[aria-label="send"]');
	if (!input || !send) return ["composer input or Send button is missing"];
	const text = `triple-click-${crypto.randomUUID()}`;
	input.focus();
	Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(input, text);
	input.setSelectionRange(text.length, text.length);
	input.dispatchEvent(new Event("input", { bubbles: true }));
	await sleep(500);
	if (input.value !== text || send.disabled) {
		return [`composer draft not ready before click (value=${JSON.stringify(input.value)}, disabled=${send.disabled})`];
	}

	send.click();
	send.click();
	send.click();
	await sleep(1600);
	const deliveredRows = [...document.querySelectorAll(".tr-row")].filter(row => row.textContent.includes(text));
	if (deliveredRows.length !== 1) {
		const locations = [...document.querySelectorAll("*")]
			.filter(element => element.childElementCount === 0 && element.textContent.includes(text))
			.map(element => `${element.tagName}.${typeof element.className === "string" ? element.className : ""}`);
		problems.push(`expected one delivered transcript row, got ${deliveredRows.length}; matching elements: ${locations.join(", ")}`);
	}
	return problems;
})();
