// omp-sweep probe (see ../capture-agents.sh): Settings > Model roles with the warning, agent profiles and model roles.
(async () => {
	const sleep = ms => new Promise(r => setTimeout(r, ms));
	const problems = [];
	const sessions = await (await fetch("/api/sessions")).json();
	location.hash = "#session=" + sessions.live[0].id;
	await sleep(1800);
	document.querySelector('button[aria-label="global settings"]').click();
	await sleep(1200);
	const title = [...document.querySelectorAll(".dk-section-title")].find(n => n.textContent.includes("Model roles"));
	if (!title) problems.push("no Model roles section");
	title?.scrollIntoView({ block: "start" });
	await sleep(500);
	if (!document.querySelector(".pf-warning")) problems.push("no warning");
	if (document.querySelectorAll(".pf-item").length < 4) problems.push("profiles/roles missing");
	return problems;
})()
