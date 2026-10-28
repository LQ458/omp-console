if (!(await click('button[aria-label="new agent"]', 1200))) return problems;
await clickText(".sp-seg-btn", "Several", 500);
const tasks = [...document.querySelectorAll(".sp-task")];
if (tasks.length < 2) problems.push("batch has fewer than two rows");
const profiles = [...document.querySelectorAll("select.sp-input")];
const fill = async (el, v) => {
	Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, v);
	el.dispatchEvent(new Event("input", { bubbles: true }));
	await sleep(150);
};
if (tasks[0]) await fill(tasks[0], "Sweep the collab docs for stale links.");
if (tasks[1]) await fill(tasks[1], "Review the backoff change #refuse");
if (profiles[1]) {
	Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(profiles[1], "reviewer");
	profiles[1].dispatchEvent(new Event("change", { bubbles: true }));
	await sleep(200);
}
await clickText(".sp-actions .sp-btn", "Spawn 2", 1800);
if (!document.querySelector('.sp-row[data-status="error"]')) problems.push("no failed row");
if (!document.querySelector('.sp-row[data-status="done"]')) problems.push("no started row");
