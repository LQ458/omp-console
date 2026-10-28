// Project workspace (docs) in plan mode: violet PLAN badge and a dashed composer border.
await open("Docs sweep");
expectThat(document.querySelector('.ws-badge[data-badge="plan"]'), "no PLAN badge");
const composer = document.querySelector(".sh-composer-inner, .sh-composer-ask .sh-composer-inner");
if (composer) expectThat(getComputedStyle(composer).borderStyle === "dashed", "composer border not dashed: " + getComputedStyle(composer).borderStyle);
return problems;
