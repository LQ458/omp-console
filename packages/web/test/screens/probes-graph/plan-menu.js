// omp-sweep probe: tapping a plan task opens its menu (do this now, split, assign).
(async () => {
	const sleep = ms => new Promise(r => setTimeout(r, ms));
	const click = async (selector, wait = 400) => {
		const el = document.querySelector(selector);
		if (!el) throw new Error("missing " + selector);
		el.click();
		await sleep(wait);
	};
	const clickText = async (selector, text, wait = 400) => {
		const el = [...document.querySelectorAll(selector)].find(node => node.textContent.includes(text));
		if (!el) throw new Error("missing " + selector + " containing " + text);
		el.click();
		await sleep(wait);
	};
	const rightClick = async (selector, wait = 500) => {
		const el = document.querySelector(selector);
		if (!el) throw new Error("missing " + selector);
		const box = el.getBoundingClientRect();
		el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 }));
		await sleep(wait);
	};
	const problems = [];
	location.hash = "#session=graph";
	await sleep(2200);
	if (!document.querySelector(".ag-panel")) await click("button[aria-label=\"show agents\"]", 600);
	await click(".ag-heading-action", 900);
	await clickText(".ag-tab", "Plan", 1200);
	const el = document.querySelector("[data-task-id=\"p1t1\"]");
	const box = el.getBoundingClientRect();
	for (const type of ["pointerdown", "pointerup"]) {
		el.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, pointerId: 7, pointerType: "mouse", clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 }));
	}
	await sleep(600);
	const items = [...document.querySelectorAll(".ag-menu-run")].map(el => el.textContent.trim());
	if (!items.some(text => text.startsWith("Do this now"))) problems.push("no Do this now: " + JSON.stringify(items));
	return problems;
})()
