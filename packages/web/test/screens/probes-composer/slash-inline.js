// omp-sweep probe (see ../capture-composer.sh): typing / at the start shows the command palette inline, with source badges.
(async () => {
	const sleep = ms => new Promise(r => setTimeout(r, ms));
	const sessions = await (await fetch("/api/sessions")).json();
	const idOf = title => sessions.live.find(s => s.title === title)?.id;
	const open = async title => {
		location.hash = "#session=" + idOf(title);
		await sleep(1800);
	};
	const type = async (text, wait = 500) => {
		const ta = document.querySelector(".sh-composer-input");
		if (!ta) throw new Error("no composer");
		ta.focus();
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta, text);
		ta.setSelectionRange(text.length, text.length);
		ta.dispatchEvent(new Event("input", { bubbles: true }));
		await sleep(wait);
	};
	const key = (key, init = {}) => {
		const ta = document.querySelector(".sh-composer-input");
		ta.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
	};
	const rows = () => [...document.querySelectorAll(".cmp-suggest-row")].map(r => r.textContent);
	const problems = [];
	await open("Refactor relay backoff");
	await type("/co");
	const found = rows();
	if (!found.some(r => r.includes("/compact"))) problems.push("no /compact row: " + JSON.stringify(found));
	return problems;
})()
