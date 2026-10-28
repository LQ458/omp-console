// "Actions in your name": read-only gate modes with the research note, and the audit table filtered to "needs attention".
await open("Refactor relay backoff");
await openPanel();
await click(".dk-segment-btn", "Actions");
await sleep(600);
expectThat(document.querySelectorAll(".sf-mode").length === 3, "gate modes missing");
expectThat(document.querySelector(".sf-evidence"), "research note missing");
await click(".sf-chip", "Needs attention");
const all = 12;
const rows = document.querySelectorAll(".sf-table tbody tr").length;
expectThat(rows > 0 && rows < all, "filter did not narrow the table: " + rows);
return problems;
