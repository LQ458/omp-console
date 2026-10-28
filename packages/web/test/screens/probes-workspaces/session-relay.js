// Project workspace (relay) with a goal and a phone client: chip with amber ring, goal + phone badges, accent bar.
await open("Refactor relay backoff");
expectThat(document.querySelector(".ws-accent-bar"), "no accent bar");
expectThat(document.querySelector(".ws-chip"), "no workspace chip");
expectThat(document.querySelector('.ws-badge[data-badge="goal"]'), "no goal badge");
expectThat(document.querySelector('.ws-badge[data-badge="phone"]'), "no phone badge");
expectThat(getComputedStyle(document.querySelector(".sh-app")).getPropertyValue("--ws-accent").trim() !== "", "--ws-accent not set");
return problems;
