const sleep = ms => new Promise(r => setTimeout(r, ms));
const problems = [];
const click = async (selector, wait = 400) => {
	const el = document.querySelector(selector);
	if (!el) { problems.push("missing " + selector); return false; }
	el.click();
	await sleep(wait);
	return true;
};
const clickText = async (selector, text, wait = 400) => {
	const el = [...document.querySelectorAll(selector)].find(node => node.textContent.includes(text));
	if (!el) { problems.push("missing " + selector + " containing " + text); return false; }
	el.click();
	await sleep(wait);
	return true;
};
const setValue = async (selector, value, wait = 150) => {
	const el = document.querySelector(selector);
	if (!el) { problems.push("missing " + selector); return; }
	const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
	Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
	el.dispatchEvent(new Event("input", { bubbles: true }));
	await sleep(wait);
};
const openControls = async () => {
	// Desktop: the model chip; phone: the sliders button.
	const chip = document.querySelector(".sc-chip") ?? document.querySelector('button[aria-label^="model and thinking"]');
	if (!chip) { problems.push("no controls button"); return; }
	chip.click();
	await sleep(700);
};
location.hash = "#session=agent-tree";
await sleep(2200);
