await openControls();
if (!document.querySelector(".sc-seg")) problems.push("no thinking control");
if (!document.querySelector(".ag-picker-list")) problems.push("no model list");
if (!document.body.textContent.includes("/effort medium")) problems.push("no omp equivalent");
