// omp-sweep probe (see ../capture-graph.sh): Graph tab of the `graph` room with message edges and kind toggles. Empty return = state reached.
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
	const nodes = document.querySelectorAll("[data-node-id]").length;
	if (nodes !== 5) problems.push("expected 5 nodes, got " + nodes);
	const edges = document.querySelectorAll("[data-message-edge]").length;
	if (edges !== 9) problems.push("expected 9 message edges, got " + edges);
	if (document.querySelectorAll(".ag-edgetoggle").length !== 4) problems.push("expected 4 edge toggles");
	return problems;
})()
