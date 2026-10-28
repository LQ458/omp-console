// Cmd+J anywhere: the slim question panel with the source checkboxes.
await open("Refactor relay backoff");
window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", metaKey: true, bubbles: true }));
await sleep(500);
expectThat(document.querySelector(".ws-quick"), "Cmd+J did not open quick ask");
expectThat(document.querySelectorAll(".ws-source input").length === 4, "configured source checkboxes missing");
const input = document.querySelector(".ws-quick-input");
if (input) await setValue(input, "What is the project deadline, and which documents are required?");
await sleep(300);
return problems;
