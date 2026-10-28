// omp-sweep probe, real browser against the mock daemon: the status sheet follows new todo results and the health poll.
//   omp-sweep --url http://127.0.0.1:<port>/ --widths 393 --height 852 --probe-only --probe-file test/screens/verify/live-status.js
(async () => {
	const sleep = ms => new Promise(r => setTimeout(r, ms));
	const sessions = await (await fetch("/api/sessions")).json();
	const relay = sessions.live.find(s => s.title === "Refactor relay backoff").id;
	const docs = sessions.live.find(s => s.title === "Docs sweep").id;
	const problems = [];
	const meta = () => document.querySelector("[aria-label=todos] .dk-section-meta")?.textContent ?? "";
	location.hash = "#session=" + relay;
	await sleep(2000);
	document.querySelector("button[aria-label^='status:']").click();
	await sleep(600);
	if (meta() !== "2/6 done") problems.push("before: " + meta());
	await fetch("/mock/todo/" + relay, { method: "POST" });
	await sleep(1000);
	if (meta() !== "3/6 done") problems.push("after todo update: " + meta());
	if (!document.querySelector(".dk-todo-task[data-status=in_progress]")?.textContent.includes("Cap pending sends")) problems.push("in-progress task did not advance");
	const card = () => [...document.querySelectorAll(".dk-health-card")].find(c => c.textContent.includes("Docs sweep"));
	if (!card()) return [...problems, "no health card for Docs sweep"];
	await fetch("/mock/stall/" + docs, { method: "POST" });
	await sleep(4500); // the health poll runs every 3 s
	if (card().dataset.level !== "stalled") problems.push("health card did not turn stalled: " + card().dataset.level);
	await fetch("/mock/stall/" + docs, { method: "POST" });
	return problems;
})()
