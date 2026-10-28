// Move preview with a Tauri bridge present: the native confirmation is offered (the probe's stub declines it).
window.__TAURI_INTERNALS__ = {
	invoke: async (command, args) => {
		window.__nativeCalls = [...(window.__nativeCalls || []), { command, keys: Object.keys(args).sort() }];
		throw new Error("declined in probe");
	},
};
await open("Job: notes triage");
await sleep(4500);
await click(".sf-slug .sh-btn-primary", "Preview move");
await sleep(800);
expectThat(document.querySelector(".sf-preview"), "no preview");
const confirm = [...document.querySelectorAll(".sf-step .sh-btn-primary")].find(b => b.textContent.includes("Confirm in the Mac app"));
expectThat(confirm && !confirm.disabled, "native confirm button missing or disabled");
confirm?.click();
await sleep(500);
const calls = window.__nativeCalls || [];
expectThat(calls.length === 1 && calls[0].command === "confirm_move" && calls[0].keys.join() === "moveId,nonce,summary", "confirm_move not invoked with moveId, nonce, summary: " + JSON.stringify(calls));
expectThat(document.querySelector(".sf-step .dk-notice-warn")?.textContent.includes("Nothing was copied"), "declined dialog did not return to the preview");
const card = document.querySelector(".sf-drift");
if (card) card.scrollTop = card.scrollHeight;
await sleep(300);
return problems;
