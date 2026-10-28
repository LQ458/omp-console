// Move history with undo.
await open("Refactor relay backoff");
await openPanel();
await click(".dk-segment-btn", "Moves");
await sleep(700);
expectThat(document.querySelectorAll(".sf-move").length >= 2, "moves missing");
expectThat([...document.querySelectorAll(".sf-move .sh-btn")].some(b => b.textContent.includes("Undo")), "no undo on a finished move");
return problems;
