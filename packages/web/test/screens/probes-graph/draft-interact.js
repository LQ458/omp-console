// omp-sweep probe: drives the draft editor like a person: add tasks, fill one in, drag a line between two, try a cycle,
// select the line and delete it with the keyboard, move a node, then run with Cmd+Enter. Returns problems; a screenshot of the result follows.
(async () => {
	const sleep = ms => new Promise(r => setTimeout(r, ms));
	const problems = [];
	const clickText = async (selector, text, wait = 400) => {
		const el = [...document.querySelectorAll(selector)].find(node => node.textContent.includes(text));
		if (!el) throw new Error("missing " + selector + " containing " + text);
		el.click();
		await sleep(wait);
	};
	const fire = (el, type, x, y, id = 5) =>
		el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: id, pointerType: "mouse", clientX: x, clientY: y }));
	const centre = el => {
		const b = el.getBoundingClientRect();
		return { x: b.left + b.width / 2, y: b.top + b.height / 2, box: b };
	};
	const setValue = (el, value) => {
		const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
		Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
		el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
	};
	localStorage.removeItem("omp-console-plan-draft:graph");
	location.hash = "#session=graph";
	await sleep(2200);
	if (!document.querySelector(".ag-panel")) document.querySelector("button[aria-label=\"show agents\"]")?.click();
	await sleep(600);
	document.querySelector(".ag-heading-action").click();
	await sleep(900);
	await clickText(".ag-tab", "Draft", 1800);
	const edit = [...document.querySelectorAll(".de-bar .ag-btn")].find(b => b.textContent.includes("Edit draft"));
	if (edit) { edit.click(); await sleep(600); }

	// 1. add three tasks
	for (let i = 0; i < 3; i++) await clickText(".de-bar .ag-btn", "Add task", 250);
	let nodes = [...document.querySelectorAll("[data-draft-node]")];
	if (nodes.length !== 3) problems.push("add: expected 3 nodes, got " + nodes.length);

	// 2. select n1 and fill it in
	let c = centre(document.querySelector("[data-draft-node=\"n1\"]"));
	fire(document.querySelector("[data-draft-node=\"n1\"] .dn-box"), "pointerdown", c.x, c.y);
	fire(document.querySelector("[data-draft-node=\"n1\"] .dn-box"), "pointerup", c.x, c.y);
	await sleep(400);
	const panel = document.querySelector(".dp");
	if (!panel) { problems.push("select: no panel"); return problems; }
	const inputs = panel.querySelectorAll("input.dp-input, textarea.dp-input, select.dp-input");
	setValue(inputs[0], "Plan the fix");
	const select = panel.querySelector("select");
	if (![...select.options].some(o => o.value === "plan")) problems.push("profile select has no 'plan' from the catalog");
	setValue(select, "plan");
	setValue(panel.querySelector("textarea"), "Plan it");
	await sleep(300);
	if (!document.querySelector("[data-draft-node=\"n1\"]").getAttribute("aria-label").startsWith("Plan the fix")) problems.push("title did not reach the node: " + document.querySelector("[data-draft-node=\"n1\"]").getAttribute("aria-label"));

	// 3. drag from n1's output port onto n2: a dependency appears
	const port = document.querySelector("[data-draft-node=\"n1\"] [data-port-out]");
	const from = centre(port);
	const to = centre(document.querySelector("[data-draft-node=\"n2\"] .dn-box"));
	fire(port, "pointerdown", from.x, from.y, 6);
	fire(port, "pointermove", (from.x + to.x) / 2, (from.y + to.y) / 2, 6);
	fire(port, "pointermove", to.x, to.y, 6);
	fire(document.querySelector(".dc-frame"), "pointerup", to.x, to.y, 6);
	await sleep(400);
	if (!document.querySelector("[data-draft-edge=\"n1>n2\"]")) problems.push("connect: no n1>n2 edge");

	// 4. a cycle is refused with the reason
	const port2 = document.querySelector("[data-draft-node=\"n2\"] [data-port-out]");
	const f2 = centre(port2);
	const t2 = centre(document.querySelector("[data-draft-node=\"n1\"] .dn-box"));
	fire(port2, "pointerdown", f2.x, f2.y, 7);
	fire(port2, "pointermove", t2.x, t2.y, 7);
	fire(document.querySelector(".dc-frame"), "pointerup", t2.x, t2.y, 7);
	await sleep(300);
	if (document.querySelector("[data-draft-edge=\"n2>n1\"]")) problems.push("cycle: edge n2>n1 was drawn");
	if (!document.querySelector(".dc-hint")?.textContent.includes("cycle")) problems.push("cycle: no explanation shown");

	// 5. second edge, then select it and delete it with the keyboard
	const port1 = document.querySelector("[data-draft-node=\"n1\"] [data-port-out]");
	const f3 = centre(port1);
	const t3 = centre(document.querySelector("[data-draft-node=\"n3\"] .dn-box"));
	fire(port1, "pointerdown", f3.x, f3.y, 8);
	fire(port1, "pointermove", t3.x, t3.y, 8);
	fire(document.querySelector(".dc-frame"), "pointerup", t3.x, t3.y, 8);
	await sleep(300);
	const hit = document.querySelector("[data-draft-edge=\"n1>n3\"] .dc-edge-hit");
	if (!hit) problems.push("connect: no n1>n3 edge");
	else {
		hit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		await sleep(250);
		document.querySelector(".dc-frame").dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
		await sleep(300);
		if (document.querySelector("[data-draft-edge=\"n1>n3\"]")) problems.push("delete: edge n1>n3 still there");
		if (!document.querySelector("[data-draft-edge=\"n1>n2\"]")) problems.push("delete: removed the wrong edge");
	}

	// 6. move n3
	const n3 = document.querySelector("[data-draft-node=\"n3\"]");
	const before = n3.getAttribute("transform");
	const m = centre(n3.querySelector(".dn-box"));
	fire(n3.querySelector(".dn-box"), "pointerdown", m.x, m.y, 9);
	fire(document.querySelector(".dc-frame"), "pointermove", m.x + 80, m.y + 60, 9);
	fire(document.querySelector(".dc-frame"), "pointerup", m.x + 80, m.y + 60, 9);
	await sleep(300);
	if (n3.getAttribute("transform") === before) problems.push("move: node did not move");

	// 7. Cmd+Enter with an incomplete draft is blocked and says why; nothing is started
	const runsBefore = (await (await fetch("/api/sessions/graph/plans")).json()).runs.length;
	document.querySelector(".de").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
	await sleep(500);
	if (!document.querySelector(".de-issues")) problems.push("run: no problem list for an incomplete draft");
	const runsAfter = (await (await fetch("/api/sessions/graph/plans")).json()).runs.length;
	if (runsAfter !== runsBefore) problems.push("run: an invalid draft was sent");
	return problems;
})()
