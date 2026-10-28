// omp-sweep probe (see ../capture-agents.sh): picks a model for the running subagent; the result shows inline.
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
	const problems = [];
	location.hash = "#session=agent-tree";
	await sleep(2200);
	// Rail: open it on every layout (on desktop it is open once a subagent appears).
	if (!document.querySelector(".ag-panel")) await click("button[aria-label=\"show agents\"]", 600);
	await click(".ag-heading-action", 900);
	await clickText(".ag-tab", "Tree", 500);
	await clickText(".ag-tree-row", "RelayProbe", 900);
	await clickText(".ag-change-model .ag-btn", "Change model", 900);
	await clickText(".ag-picker-item", "Claude Haiku 5.5", 1200);
	const note = document.querySelector(".ag-inline-note--ok");
	if (!note) problems.push("no success note");
	return problems;
})()
