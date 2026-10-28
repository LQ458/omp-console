// omp-sweep probe: right-click on the RelayProbe node opens its action menu with the omp equivalents.
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
	await clickText(".ag-tab", "Graph", 3200);
	await rightClick("[data-node-id=\"RelayProbe\"]");
	const items = [...document.querySelectorAll(".ag-menu-run")].map(el => el.textContent.trim());
	if (!items.some(text => text.startsWith("Message"))) problems.push("no Message item: " + JSON.stringify(items));
	if (document.querySelectorAll(".ag-menu .ag-omp").length < 5) problems.push("menu items lack omp equivalents");
	return problems;
})()
