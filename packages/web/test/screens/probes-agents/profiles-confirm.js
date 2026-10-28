// omp-sweep probe (see ../capture-agents.sh): editing the reviewer profile: picker, then the confirm step.
(async () => {
	const sleep = ms => new Promise(r => setTimeout(r, ms));
	const problems = [];
	const sessions = await (await fetch("/api/sessions")).json();
	location.hash = "#session=" + sessions.live[0].id;
	await sleep(1800);
	document.querySelector('button[aria-label="global settings"]').click();
	await sleep(1200);
	const item = [...document.querySelectorAll(".pf-item")].find(n => n.querySelector(".pf-name")?.textContent.startsWith("reviewer"));
	if (!item) return ["no reviewer profile"];
	item.querySelector(".pf-btn").click();
	await sleep(600);
	[...document.querySelectorAll(".pf-edit .ag-picker-item")].find(n => n.textContent.includes("Claude Haiku 5.5"))?.click();
	await sleep(600);
	if (!document.querySelector(".pf-confirm")) problems.push("no confirm step");
	document.querySelector(".pf-confirm")?.scrollIntoView({ block: "center" });
	await sleep(400);
	return problems;
})()
