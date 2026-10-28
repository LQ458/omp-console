if (!(await click('button[aria-label="new agent"]', 1200))) return problems;
await clickText(".sp-actions .sp-btn", "Spawn agent", 500);
if (!document.querySelector(".sp-field-err")) problems.push("no validation message");
