const sleep = ms => new Promise(r => setTimeout(r, ms));
const problems = [];
const phone = innerWidth < 760;
const sessions = await (await fetch("/api/sessions")).json();
const open = async title => {
	const s = sessions.live.find(x => x.title === title);
	if (!s) {
		problems.push("no session " + title);
		return;
	}
	location.hash = "#session=" + s.id;
	await sleep(2000);
};
const click = async (selector, text) => {
	const el = [...document.querySelectorAll(selector)].find(n => !text || n.textContent.includes(text));
	if (!el) {
		problems.push("missing " + selector + (text ? " containing " + text : ""));
		return false;
	}
	el.click();
	await sleep(500);
	return true;
};
const expectThat = (condition, message) => {
	if (!condition) problems.push(message);
};
const openPanel = async () => {
	if (phone) await click('button[aria-label^="sessions, current"]');
	await click("button[aria-label=workspaces]");
	await sleep(700);
};
const setValue = async (el, value) => {
	const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
	Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
	el.dispatchEvent(new Event("input", { bubbles: true }));
	await sleep(300);
};
