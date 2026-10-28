// omp-sweep probe, real browser against the mock daemon: the away-mode flow takes two taps.
//   omp-sweep --url http://127.0.0.1:<port>/ --widths 393 --height 852 --probe-only --probe-file test/screens/verify/two-taps.js
// Session "Refactor relay backoff" is open; "Docs sweep" waits on a question. Tap 1: the needs-you row opens it.
// Tap 2: an option answers it. Afterwards the bar and the form are gone and the host logged the answer.
(async () => {
	const sleep = ms => new Promise(r => setTimeout(r, ms));
	const sessions = await (await fetch("/api/sessions")).json();
	const id = t => sessions.live.find(s => s.title === t).id;
	const problems = [];
	location.hash = "#session=" + id("Refactor relay backoff");
	await sleep(2000);
	const row = document.querySelector(".dk-needs-row");
	if (!row) return ["no needs-you row while Docs sweep waits"];
	let taps = 0;
	row.click(); taps++;
	await sleep(2000);
	const option = [...document.querySelectorAll(".sh-ask-option")].find(b => b.dataset.answer === "Only report mismatches");
	if (!option) return ["ask form did not open after tap 1"];
	option.click(); taps++;
	await sleep(1500);
	if (document.querySelector(".sh-ask-option")) problems.push("ask form still shown after the answer");
	if (document.querySelector(".dk-needs-row")) problems.push("needs-you bar still shown after the answer");
	const after = await (await fetch("/api/sessions")).json();
	if (after.live.find(s => s.title === "Docs sweep").awaitingAnswer) problems.push("daemon still reports awaitingAnswer");
	if (taps !== 2) problems.push("taps = " + taps);
	return problems;
})()
