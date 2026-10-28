// Prompt history (Up/Down in an empty composer) and per-session drafts that survive reusing the pane.
await open("pane-1");
await send("alpha prompt", 600);
await send("beta prompt", 600);
expect(composer().value === "", "composer should be empty after sending");
await arrow("ArrowUp");
expect(composer().value === "beta prompt", "Up should show the newest prompt, got " + JSON.stringify(composer().value));
await arrow("ArrowUp");
expect(composer().value === "alpha prompt", "Up again should show the older prompt, got " + JSON.stringify(composer().value));
await arrow("ArrowDown");
expect(composer().value === "beta prompt", "Down should walk forward, got " + JSON.stringify(composer().value));
await arrow("ArrowDown");
expect(composer().value === "", "Down past the newest should return to empty, got " + JSON.stringify(composer().value));
// Draft: type, switch this pane to another session, come back.
await setValue("textarea.sh-composer-input", "half-written thought");
await sleep(600);
await open("pane-2");
expect(composer().value === "", "another session starts with its own empty composer, got " + JSON.stringify(composer().value));
await open("pane-1");
expect(composer().value === "half-written thought", "the draft should come back, got " + JSON.stringify(composer().value));
