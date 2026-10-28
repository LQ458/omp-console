await openControls();
await clickText(".ag-picker-item", "Claude Opus 5.5", 900);
await clickText(".sc-seg-btn", "high", 900);
if (!document.querySelector(".sc-msg-ok")) problems.push("no success note");
const on = document.querySelector('.sc-seg-btn[data-on="true"]');
if (!on || on.textContent.trim() !== "high") problems.push("thinking not shown as high");
