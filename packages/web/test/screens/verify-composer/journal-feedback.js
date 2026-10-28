// omp-sweep behaviour probe (see ../README.md): journal + feedback round trip: UI actions reach the daemon within the 5 s batch, typed prompt text never does, feedback links screen and feature.
(async () => {
	const sleep = ms => new Promise(r => setTimeout(r, ms));
	const sessions = await (await fetch("/api/sessions")).json();
	const idOf = title => sessions.live.find(s => s.title === title)?.id;
	const open = async title => {
		location.hash = "#session=" + idOf(title);
		await sleep(1800);
	};
	const ta = () => document.querySelector(".sh-composer-input");
	const type = async (text, wait = 500) => {
		ta().focus();
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta(), text);
		ta().setSelectionRange(text.length, text.length);
		ta().dispatchEvent(new Event("input", { bubbles: true }));
		await sleep(wait);
	};
	const key = (k, init = {}) => ta().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
	const rows = () => [...document.querySelectorAll(".cmp-suggest-row")].map(r => r.textContent);
	const drop = (data, files = []) => {
		const dt = new DataTransfer();
		for (const [type, value] of Object.entries(data)) dt.setData(type, value);
		for (const f of files) dt.items.add(f);
		const target = document.querySelector(".cmp-inner");
		target.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
		target.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
	};
	const commands = async () => (await (await fetch("/api/mock/commands")).json());
	const expectEq = (problems, label, actual, expected) => {
		if (JSON.stringify(actual) !== JSON.stringify(expected)) problems.push(label + ": expected " + JSON.stringify(expected) + " got " + JSON.stringify(actual));
	};
	const problems = [];
	await open("Refactor relay backoff");
	await fetch("/api/journal", { method: "DELETE" });
	await type("my private deployment plan for friday", 100);
	window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }));
	await sleep(500);
	document.querySelector(".ct-pal-input").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
	await sleep(200);
	document.querySelector("button[aria-label=\"what omp can do\"]").click();
	await sleep(700);
	[...document.querySelectorAll(".ct-feedback-btn")].find(b => b.textContent.includes("Feedback")).click();
	await sleep(200);
	const area = document.querySelector(".ct-feedback-area");
	Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(area, "Spawn should ask which model");
	area.dispatchEvent(new Event("input", { bubbles: true }));
	await sleep(100);
	document.querySelector(".ct-feedback button[type=submit]").click();
	await sleep(6000);
	const stored = await (await fetch("/api/journal")).json();
	const features = stored.events.map(e => e.feature + ":" + e.action);
	for (const want of ["5.2.palette:open", "5.2.palette:dismiss", "0.1.catalog:open", "0.6.feedback:submit"]) {
		if (!features.includes(want)) problems.push("missing journal event " + want + " in " + JSON.stringify(features));
	}
	if (JSON.stringify(stored.events).includes("deployment plan")) problems.push("prompt text leaked into the journal");
	expectEq(problems, "feedback", stored.feedback.map(f => [f.screen, f.feature, f.text]), [["catalog", "0.1.catalog", "Spawn should ask which model"]]);
	if (!stored.events.every(e => e.sessionId)) problems.push("an event has no sessionId");
	return problems;
})()
