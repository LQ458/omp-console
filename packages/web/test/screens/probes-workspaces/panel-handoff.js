// Workspaces sheet opened from a knowledge session: a project row offers "Start from current session" (handoff).
await open("Job: notes triage");
await openPanel();
await click(".ws-item-head", "docs");
expectThat([...document.querySelectorAll(".ws-item-body button")].some(b => b.textContent.includes("Start from current session")), "no handoff button");
return problems;
