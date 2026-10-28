// omp-sweep behaviour probe (see ../README.md): dropping Finder file URIs inserts @relative inside the session cwd and a quoted absolute path outside; prose drops stay text.
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
	await type("check ", 100);
	drop({ "text/uri-list": "file:///Users/dev/relay/src/index.ts" });
	await sleep(300);
	expectEq(problems, "inside cwd", ta().value, "check @src/index.ts ");
	await type("", 100);
	drop({ "text/uri-list": "file:///Users/alice/Desktop/a%20b.png\r\nfile:///Users/alice/Projects/relay/docs/release%20notes.md" });
	await sleep(300);
	expectEq(problems, "mixed", ta().value, "@\"/Users/alice/Desktop/a b.png\" @\"docs/release notes.md\" ");
	await type("", 100);
	drop({ "text/plain": "/compact now" });
	await sleep(300);
	expectEq(problems, "prose", ta().value, "/compact now ");
	return problems;
})()
