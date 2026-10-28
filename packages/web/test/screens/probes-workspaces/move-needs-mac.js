// Move preview in a browser (no Tauri bridge): daemon facts and "Confirm on the Mac app"; nothing is sent.
await open("Job: notes triage");
await sleep(4500);
const posts = [];
const originalFetch = window.fetch;
window.fetch = (input, init) => {
	if (init?.method === "POST" && String(input).includes("/confirm")) posts.push(String(input));
	return originalFetch(input, init);
};
await click(".sf-slug .sh-btn-primary", "Preview move");
await sleep(800);
expectThat(document.querySelector(".sf-preview"), "no preview");
const confirm = [...document.querySelectorAll(".sf-step .sh-btn-primary")].find(b => b.textContent.includes("Confirm on the Mac app"));
expectThat(confirm && confirm.disabled, "confirm is not disabled outside the Mac app");
confirm?.click();
await sleep(400);
window.fetch = originalFetch;
expectThat(posts.length === 0, "a confirm request was sent without the Mac app");
const card = document.querySelector(".sf-drift");
if (card) card.scrollTop = card.scrollHeight;
await sleep(300);
return problems;
