const sleep = ms => new Promise(r => setTimeout(r, ms));
const problems = [];
const sessions = await (await fetch("/api/sessions")).json();
const idOf = title => sessions.live.find(s => s.title === title)?.id;
// Cmd-chords go to the window like a real keypress; the pane host listens there.
const key = async (k, mods = {}, wait = 500) => {
	window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, metaKey: true, ...mods }));
	await sleep(wait);
};
const splitRight = () => key("d");
const splitDown = () => key("D", { shiftKey: true });
const focusDir = dir => key("Arrow" + dir, { altKey: true });
const moveDir = dir => key("Arrow" + dir, { shiftKey: true });
// `#session=<id>` opens the session in the focused pane (the same path a notification tap takes).
const open = async (id, wait = 1500) => {
	location.hash = "#session=" + id;
	await sleep(wait);
};
const paneIds = () => [...document.querySelectorAll(".pn-frame")].map(el => el.dataset.pane);
const focusedPane = () => document.querySelector('.pn-frame[data-focused="true"]')?.dataset.pane;
const expect = (cond, message) => {
	if (!cond) problems.push(message);
};
const rectOf = id => document.querySelector(`.pn-frame[data-pane="${id}"]`)?.getBoundingClientRect();
const setValue = async (selector, value, wait = 150) => {
	const el = document.querySelector(selector);
	if (!el) {
		problems.push("missing " + selector);
		return;
	}
	const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
	Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
	el.dispatchEvent(new Event("input", { bubbles: true }));
	await sleep(wait);
};
const composer = () => document.querySelector(".pn-frame[data-focused=true] textarea.sh-composer-input") ?? document.querySelector("textarea.sh-composer-input");
const send = async (text, wait = 400) => {
	await setValue("textarea.sh-composer-input", text);
	document.querySelector('button[aria-label="send"]')?.click();
	await sleep(wait);
};
const arrow = async (name, wait = 150) => {
	const ta = composer();
	ta.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
	await sleep(wait);
};
