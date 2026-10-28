// omp-sweep probe: Plan tab, todo phases as columns with inferred agent links.
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
	const tasks = document.querySelectorAll("[data-task-id]").length;
	if (tasks !== 8) problems.push("expected 8 tasks, got " + tasks);
	const chips = document.querySelectorAll("[data-agent-chip]").length;
	if (chips !== 2) problems.push("expected 2 inferred agent links, got " + chips);
	return problems;
})()
