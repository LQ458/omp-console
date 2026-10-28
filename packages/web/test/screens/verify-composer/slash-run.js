// omp-sweep behaviour probe (see ../README.md): inline /context + Enter runs remotely, clears the token and shows the omp equivalent; a TUI-only command with a control opens its panel.
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
	let opened = null;
	window.addEventListener("omp-console:open-panel", e => { opened = e.detail; });
	await type("/context");
	key("Enter");
	await sleep(600);
	expectEq(problems, "composer cleared", ta().value, "");
	expectEq(problems, "daemon commands", await commands(), ["/context"]);
	if (!(document.querySelector(".cmp-note .ct-omp-text")?.textContent ?? "").includes("/context")) problems.push("no equivalent in note");
	await type("/todo");
	key("Enter");
	await sleep(500);
	expectEq(problems, "panel event", opened, { panel: "status" });
	await type("/goal");
	key("Enter");
	await sleep(400);
	expectEq(problems, "filled", ta().value, "/goal ");
	expectEq(problems, "daemon commands unchanged", await commands(), ["/context"]);
	return problems;
})()
