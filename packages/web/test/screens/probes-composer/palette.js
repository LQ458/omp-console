// omp-sweep probe (see ../capture-composer.sh): Cmd+K opens the command palette; typing narrows it and the footer shows the omp equivalent.
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
	window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }));
	await sleep(700);
	const input = document.querySelector(".ct-pal-input");
	if (!input) throw new Error("palette did not open");
	Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "comp");
	input.dispatchEvent(new Event("input", { bubbles: true }));
	await sleep(400);
	if (!document.querySelector(".ct-pal-item")) problems.push("no palette rows");
	if (!document.querySelector(".ct-omp-text")) problems.push("no omp equivalent line");
	return problems;
})()
