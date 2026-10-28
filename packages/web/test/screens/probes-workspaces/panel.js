// Workspaces sheet: groups, git status, live counts, the current workspace expanded with actions and the colour picker.
await open("Refactor relay backoff");
await openPanel();
expectThat(document.querySelectorAll(".ws-item").length >= 5, "workspaces missing: " + document.querySelectorAll(".ws-item").length);
expectThat(document.querySelector(".ws-item[data-open=true] .ws-hue"), "colour picker not shown for the open workspace");
expectThat([...document.querySelectorAll(".ws-item-body button")].some(b => b.textContent.includes("New session here")), "no new-session button");
return problems;
