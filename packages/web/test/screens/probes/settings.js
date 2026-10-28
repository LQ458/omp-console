// omp-sweep probe (see ../capture.sh): settings sheet. Returns problem strings; empty means the state was reached.
(async () => {
	const sleep = ms => new Promise(r => setTimeout(r, ms));
	const sessions = await (await fetch("/api/sessions")).json();
	const idOf = title => sessions.live.find(s => s.title === title)?.id;
	const click = async (selector, wait = 400) => {
		const el = document.querySelector(selector);
		if (!el) throw new Error("missing " + selector);
		el.click();
		await sleep(wait);
	};
	const open = async title => {
		location.hash = "#session=" + idOf(title);
		await sleep(1800);
	};
	const problems = [];
	await open("Refactor relay backoff");
	await click("button[aria-label=settings]", 800);
	return problems;
})()
