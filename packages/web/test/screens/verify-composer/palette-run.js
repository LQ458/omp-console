// omp-sweep behaviour probe (see ../README.md): Cmd+K: typing a command with arguments runs it through the daemon with those arguments, and the palette says so.
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
	window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }));
	await sleep(600);
	const input = document.querySelector(".ct-pal-input");
	Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "compact soft");
	input.dispatchEvent(new Event("input", { bubbles: true }));
	await sleep(300);
	input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
	await sleep(400);
	if (!(document.querySelector(".ct-status")?.textContent ?? "").includes("/compact soft")) problems.push("no ran status");
	expectEq(problems, "daemon commands", await commands(), ["/compact soft"]);
	await sleep(1200);
	if (document.querySelector(".ct-pal")) problems.push("palette stayed open after a run");
	return problems;
})()
