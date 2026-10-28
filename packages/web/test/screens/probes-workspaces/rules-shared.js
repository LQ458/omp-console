// Shared rule file: edit, save (never committed by deck), then the git diff vs HEAD.
await open("Refactor relay backoff");
await openPanel();
await click(".ws-item[data-open=true] .ws-row-actions button", "Rules");
await click(".ws-rule-row", "AGENTS.md");
await sleep(600);
const editor = document.querySelector(".ws-editor-text");
if (editor) {
	await setValue(editor, editor.value.replace(/\n$/, "") + "\nRun the relay fixture before touching backoff.\n");
	await click(".ws-editor .sh-btn-primary");
	await sleep(700);
} else problems.push("no editor");
await click(".ws-editor .ws-row-actions button", "Diff vs HEAD");
expectThat(document.querySelectorAll('.ws-diff-line[data-kind="add"]').length > 0, "no added lines in the diff");
document.querySelector(".ws-diff")?.scrollIntoView({ block: "center" });
await sleep(300);
return problems;
