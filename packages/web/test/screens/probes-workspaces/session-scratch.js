// Scratch workspace: neutral grey, no badges, and no drift polling (only knowledge sessions are polled).
const driftCalls = [];
const originalFetch = window.fetch;
window.fetch = (input, init) => {
	if (String(input).includes("/drift")) driftCalls.push(String(input));
	return originalFetch(input, init);
};
await open("Scratch: regex check");
await sleep(4500);
window.fetch = originalFetch;
expectThat(document.querySelector(".ws-chip"), "no workspace chip");
expectThat(!document.querySelector(".ws-badge"), "unexpected badge");
expectThat(!document.querySelector(".sf-drift"), "drift card in a scratch session");
expectThat(driftCalls.length === 0, "drift polled in a scratch session: " + driftCalls.length);
return problems;
