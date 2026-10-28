// omp-sweep probe (see ../capture.sh): transcript while a turn streams. Needs the mock daemon's --fixtures rooms,
// whose "bench: 100 tokens/s stream" session streams continuously. Returns problem strings; empty means the state was reached.
(async () => {
	const sleep = ms => new Promise(r => setTimeout(r, ms));
	const sessions = await (await fetch("/api/sessions")).json();
	const id = sessions.live.find(s => s.title === "bench: 100 tokens/s stream")?.id;
	if (!id) return ["no streaming fixture session (start the mock daemon with --fixtures)"];
	location.hash = "#session=" + id;
	await sleep(2500);
	const problems = [];
	if (!document.querySelector('button[aria-label="stop the current turn"]')) problems.push("no stop button while streaming");
	return problems;
})()
