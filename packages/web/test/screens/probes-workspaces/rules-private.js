// Rules editor: private/shared explanation, file list with badges, a private file open in the editor.
await open("Refactor relay backoff");
await openPanel();
await click(".ws-item[data-open=true] .ws-row-actions button", "Rules");
expectThat(document.querySelectorAll(".ws-vis-card").length === 2, "visibility cards missing");
await click(".ws-rule-row", "testing.md");
await sleep(600);
const editor = document.querySelector(".ws-editor-text");
expectThat(editor && editor.value.includes("bun test"), "private file content not loaded");
expectThat(document.querySelector(".ws-editor[data-visibility=private]"), "editor is not private");
document.querySelector(".ws-editor-text")?.scrollIntoView({ block: "center" });
await sleep(300);
return problems;
