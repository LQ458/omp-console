// omp-sweep probe: Draft tab with a hand-made draft (stored the way the editor stores it) and a node selected.
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
	const node = (id, title, instruction, profile, x, y, dependsOn = [], extra = {}) => ({ id, title, instruction, profile, files: [], isolated: false, dependsOn, x, y, ...extra });
	localStorage.setItem("omp-console-plan-draft:graph", JSON.stringify({
		v: 1,
		name: "Reconnect fix",
		nextId: 6,
		nodes: [
			node("n1", "Plan the fix", "Plan the reconnect fix and list the files to touch.", "plan", 24, 24),
			node("n2", "Probe the relay", "Reproduce the dead socket against a restarted relay.", "task", 276, 24, ["n1"], { files: ["packages/coding-agent/src/collab/relay-client.ts"] }),
			node("n3", "Sweep the docs", "Find docs that mention close code 1006.", "explore", 276, 122, ["n1"]),
			node("n4", "Regression test", "Add a reconnect test.", "task", 528, 24, ["n2"], { isolated: true }),
			node("n5", "Review", "Review the fix and run the suite.", "", 528, 122, ["n3", "n4"]),
		],
	}));
	await clickText(".ag-tab", "Draft", 1500);
	const edit = [...document.querySelectorAll(".de-bar .ag-btn")].find(b => b.textContent.includes("Edit draft"));
	if (edit) {
		edit.click();
		await sleep(600);
	}
	const count = document.querySelectorAll("[data-draft-node]").length;
	if (count !== 5) problems.push("expected 5 draft nodes, got " + count);
	const el = document.querySelector("[data-draft-node=\"n2\"]");
	const box = el.getBoundingClientRect();
	for (const type of ["pointerdown", "pointerup"]) {
		el.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, pointerId: 9, pointerType: "mouse", clientX: box.left + 40, clientY: box.top + 20 }));
	}
	await sleep(500);
	if (!document.querySelector(".dp")) problems.push("no node panel after selecting n2");
	return problems;
})()
