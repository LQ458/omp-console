// omp-sweep behaviour probe (see ../README.md): Tab accepts a directory (list stays open on its children), then a file; Esc dismisses until the token changes.
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
	await type("Fix @src/re");
	key("Tab");
	await sleep(500);
	expectEq(problems, "after dir", ta().value, "Fix @src/relay/");
	if (rows().length === 0) problems.push("list closed after accepting a directory");
	key("ArrowDown");
	await sleep(150);
	key("Tab");
	await sleep(300);
	expectEq(problems, "after file", ta().value, "Fix @src/relay/socket.ts ");
	await type("see @doc");
	key("Escape");
	await sleep(200);
	if (rows().length !== 0) problems.push("Esc did not close the list");
	await type("see @doc @docs/");
	if (rows().length === 0) problems.push("list did not reopen for a new token");
	await type("see @docs/release n");
	key("ArrowDown");
	await type("see @docs/release");
	key("Tab");
	await sleep(300);
	expectEq(problems, "quoted file", ta().value, "see @\"docs/release notes.md\" ");
	return problems;
})()
