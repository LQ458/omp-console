// omp-sweep behaviour probe: pan, zoom, tap-to-select and kill on the agent graph (real pointer and wheel events in Chromium).
// Run against `bun dev/mock-daemon.ts --agent-tree --dist dist` (see ../README.md). Returns problem strings; empty = all held.
(async () => {
	const sleep = ms => new Promise(r => setTimeout(r, ms));
	const problems = [];
	location.hash = "#session=agent-tree";
	await sleep(2200);
	if (!document.querySelector(".ag-panel")) document.querySelector("button[aria-label=\"show agents\"]").click();
	await sleep(500);
	document.querySelector(".ag-heading-action").click();
	await sleep(600);
	[...document.querySelectorAll(".ag-tab")].find(n => n.textContent.includes("Graph")).click();
	await sleep(900);

	const frame = document.querySelector(".ag-graph-frame");
	const group = () => document.querySelector(".ag-graph-svg > g");
	const transform = () => {
		const m = /translate\(([-\d.e]+) ([-\d.e]+)\) scale\(([-\d.e]+)\)/.exec(group().getAttribute("transform"));
		return { x: +m[1], y: +m[2], k: +m[3] };
	};
	const rect = frame.getBoundingClientRect();
	const cx = rect.left + rect.width / 2;
	const cy = rect.top + rect.height / 2;
	const pointer = (type, x, y, id = 1, target = frame) =>
		target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: id, clientX: x, clientY: y, isPrimary: true, button: 0 }));

	// Zoom: the wheel scales the graph and keeps the point under the cursor fixed.
	const before = transform();
	frame.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -300, clientX: cx, clientY: cy }));
	await sleep(150);
	const zoomed = transform();
	if (!(zoomed.k > before.k)) problems.push("wheel did not zoom in: " + JSON.stringify({ before, zoomed }));
	const fixedBefore = { x: (cx - rect.left - before.x) / before.k, y: (cy - rect.top - before.y) / before.k };
	const fixedAfter = { x: (cx - rect.left - zoomed.x) / zoomed.k, y: (cy - rect.top - zoomed.y) / zoomed.k };
	if (Math.abs(fixedBefore.x - fixedAfter.x) > 0.5 || Math.abs(fixedBefore.y - fixedAfter.y) > 0.5) problems.push("zoom did not keep the cursor point fixed");

	// Pan: dragging the background moves the graph by the drag distance.
	const start = transform();
	pointer("pointerdown", rect.left + 20, rect.top + 20);
	pointer("pointermove", rect.left + 60, rect.top + 50);
	pointer("pointermove", rect.left + 120, rect.top + 80);
	pointer("pointerup", rect.left + 120, rect.top + 80);
	await sleep(150);
	const panned = transform();
	if (Math.abs(panned.x - start.x - 100) > 1 || Math.abs(panned.y - start.y - 60) > 1) problems.push("drag moved the graph by " + JSON.stringify({ dx: panned.x - start.x, dy: panned.y - start.y }));
	if (document.querySelector(".ag-drawer")) problems.push("a drag opened the drawer");

	// Fit restores a view where every node is visible.
	document.querySelector("button[aria-label=\"fit to view\"]").click();
	await sleep(200);
	const fr = frame.getBoundingClientRect();
	for (const node of document.querySelectorAll("[data-node-id]")) {
		const r = node.getBoundingClientRect();
		if (r.left < fr.left - 1 || r.right > fr.right + 1 || r.top < fr.top - 1 || r.bottom > fr.bottom + 1) problems.push("node outside the frame after fit: " + node.dataset.nodeId);
	}

	// Tap: a press and release without movement on a node opens that agent's drawer.
	const node = document.querySelector("[data-node-id=\"RelayProbe\"]");
	const nr = node.getBoundingClientRect();
	pointer("pointerdown", nr.left + 40, nr.top + 20, 2, node.querySelector(".ag-gnode-box"));
	pointer("pointerup", nr.left + 40, nr.top + 20, 2, node.querySelector(".ag-gnode-box"));
	await sleep(700);
	const drawer = document.querySelector(".ag-drawer");
	if (!drawer || drawer.getAttribute("aria-label") !== "RelayProbe") problems.push("tapping the node did not open its drawer");

	// Kill from the drawer: the registry change arrives as an agents frame and the node turns aborted.
	const kill = [...document.querySelectorAll(".ag-drawer .ag-btn")].find(n => n.textContent.includes("kill"));
	if (!kill) problems.push("no kill button for a running agent");
	else {
		kill.click();
		await sleep(400);
		const deadline = Date.now() + 14000; // the mock room republishes the agents frame every 10 s
		while (!document.querySelector("[data-node-id=\"RelayProbe\"].ag-gnode--aborted") && Date.now() < deadline) await sleep(250);
		if (!document.querySelector("[data-node-id=\"RelayProbe\"].ag-gnode--aborted")) problems.push("killed agent did not turn aborted in the graph");
	}
	return problems;
})()
