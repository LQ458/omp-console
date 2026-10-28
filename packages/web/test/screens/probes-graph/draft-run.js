// omp-sweep probe: Draft tab on a run in progress (the seeded run): node states, elapsed time, agent links.
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
	localStorage.removeItem("omp-console-plan-draft:graph");
	await clickText(".ag-tab", "Draft", 2200);
	const states = [...document.querySelectorAll("[data-draft-node]")].map(el => el.getAttribute("aria-label"));
	const want = ["done", "running", "running", "waiting", "waiting"];
	states.forEach((label, i) => { if (!label.endsWith(want[i])) problems.push("node " + i + " is '" + label + "', want " + want[i]); });
	if (!document.querySelector(".dn-open")) problems.push("no open-agent link on a started node");
	return problems;
})()
