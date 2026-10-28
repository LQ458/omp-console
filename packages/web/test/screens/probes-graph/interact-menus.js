// omp-sweep probe: drives the node menus like a person. Touch long-press opens the agent menu without selecting the node;
// Message, Ask and a two-step Kill report back; the plan menu's Do this now / Assign / Split reach the shell as events or frames.
(async () => {
	const sleep = ms => new Promise(r => setTimeout(r, ms));
	const problems = [];
	const clickText = async (selector, text, wait = 400) => {
		const el = [...document.querySelectorAll(selector)].find(node => node.textContent.includes(text));
		if (!el) throw new Error("missing " + selector + " containing " + text);
		el.click();
		await sleep(wait);
	};
	const fire = (el, type, x, y, extra = {}) =>
		el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 3, pointerType: "touch", clientX: x, clientY: y, ...extra }));
	const setValue = (el, value) => {
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, value);
		el.dispatchEvent(new Event("input", { bubbles: true }));
	};
	const events = [];
	window.addEventListener("omp-console:open-panel", e => events.push(JSON.stringify(e.detail)));
	location.hash = "#session=graph";
	await sleep(2200);
	if (!document.querySelector(".ag-panel")) document.querySelector("button[aria-label=\"show agents\"]")?.click();
	await sleep(600);
	document.querySelector(".ag-heading-action").click();
	await sleep(900);
	await clickText(".ag-tab", "Graph", 1500);

	// long-press on RelayProbe (touch): menu opens, node is not selected (no drawer)
	const node = document.querySelector("[data-node-id=\"RelayProbe\"]");
	const b = node.getBoundingClientRect();
	fire(node, "pointerdown", b.left + 20, b.top + 20);
	await sleep(750);
	fire(node, "pointerup", b.left + 20, b.top + 20);
	await sleep(300);
	if (!document.querySelector(".ag-menu")) problems.push("long-press: no menu");
	if (document.querySelector(".ag-drawer")) problems.push("long-press: the node was also selected");

	// Message: compose, send, see the confirmation
	await clickText(".ag-menu-run", "Message", 300);
	const area = document.querySelector(".ag-menu-textarea");
	if (!area) problems.push("message: no composer");
	else {
		setValue(area, "use backoff 2s");
		await sleep(150);
		await clickText(".ag-menu-compose-foot .ag-btn", "Send", 400);
		if (!document.querySelector(".ag-menu-notice")?.textContent.includes("Sent to RelayProbe")) problems.push("message: no confirmation");
	}
	await sleep(1600);
	if (document.querySelector(".ag-menu")) problems.push("message: menu stayed open after the confirmation");

	// Kill needs a second click
	const again = document.querySelector("[data-node-id=\"RelayProbe\"]");
	const c = again.getBoundingClientRect();
	again.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: c.left + 30, clientY: c.top + 30 }));
	await sleep(400);
	await clickText(".ag-menu-run", "Kill", 300);
	if (!document.querySelector(".ag-menu-run")?.parentElement) problems.push("kill: menu vanished on the first click");
	const armed = [...document.querySelectorAll(".ag-menu-run")].find(el => el.textContent.includes("Click again to kill"));
	if (!armed) problems.push("kill: not armed after one click");
	else {
		armed.click();
		await sleep(300);
		if (!document.querySelector(".ag-menu-notice")?.textContent.includes("Killed")) problems.push("kill: no confirmation after the second click");
	}
	await sleep(1600);

	// Plan menu: Do this now and Assign dispatch omp-console:open-panel; Split confirms
	await clickText(".ag-tab", "Plan", 1000);
	const open = async index => {
		const task = document.querySelectorAll("[data-task-id]")[index];
		const tb = task.getBoundingClientRect();
		task.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: tb.left + 30, clientY: tb.top + 20 }));
		await sleep(400);
	};
	await open(3);
	await clickText(".ag-menu-run", "Do this now", 300);
	await open(3);
	await clickText(".ag-menu-run", "Assign to agent profile", 300);
	await open(3);
	await clickText(".ag-menu-run", "Split into subtasks", 300);
	if (!document.querySelector(".ag-menu-notice")?.textContent.includes("split")) problems.push("split: no confirmation");
	if (events.length !== 2) problems.push("expected 2 omp-console:open-panel events, got " + JSON.stringify(events));
	else {
		const [now, assign] = events.map(e => JSON.parse(e));
		if (now.panel !== "spawn" || !now.task.startsWith("Treat close code 1001")) problems.push("do-now detail: " + events[0]);
		if (assign.focus !== "profile") problems.push("assign detail: " + events[1]);
	}
	return problems;
})()
