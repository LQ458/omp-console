await openControls();
await clickText(".sc-seg-btn", "xhigh", 900);
if (!document.querySelector(".sc-msg-err")) problems.push("no error shown");
