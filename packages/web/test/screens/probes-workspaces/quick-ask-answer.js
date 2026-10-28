// Ask, then the answer in a side sheet (a second guest of the knowledge session).
await open("Refactor relay backoff");
window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", metaKey: true, bubbles: true }));
await sleep(500);
const input = document.querySelector(".ws-quick-input");
if (input) await setValue(input, "What is the project deadline, and which documents are required?");
await click(".ws-quick button[type=submit]");
await sleep(3500);
expectThat(document.querySelector(".ws-answer"), "no answer sheet");
expectThat(document.querySelector(".ws-answer")?.textContent.includes("12 March"), "answer text missing");
return problems;
