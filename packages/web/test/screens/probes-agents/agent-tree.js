// omp-sweep probe (see ../capture-agents.sh): the indented agent tree (the phone default) with the summary row.
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
	await clickText(".ag-tab", "Tree", 600);
	if (document.querySelectorAll(".ag-tree-row").length !== 5) problems.push("expected 5 tree rows");
	if (!document.querySelector(".ag-chip--stalled")) problems.push("no stalled flag");
	return problems;
})()
