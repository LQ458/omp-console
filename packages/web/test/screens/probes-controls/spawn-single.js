if (!(await click('button[aria-label="new agent"]', 1200))) return problems;
await clickText(".sp-profile", "reviewer", 300);
await setValue(".sp-task", "Review the relay backoff change and run the reconnect probe.");
await setValue('input[aria-label="file path to add"]', "src/lib/socket.ts");
await clickText(".sp-file-add .sp-btn", "Add", 300);
await setValue('input[aria-label="file path to add"]', "docs/relay notes.md");
await clickText(".sp-file-add .sp-btn", "Add", 300);
const iso = document.querySelector(".sp-check input");
if (iso) { iso.click(); await sleep(200); }
if (!document.querySelector(".sp-omp-code")) problems.push("no omp equivalent");
