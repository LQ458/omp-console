await open("pane-1");
await splitRight();
await open("pane-2");
await key("Enter", { shiftKey: true }, 800);
expect(document.querySelector('.pn-host[data-zoomed="true"]'), "not zoomed");
const mounted = () => [...document.querySelectorAll(".pn-frame")].filter(el => el.querySelector(".sh-transcript")).length;
expect(mounted() === 1, "zoomed layout keeps " + mounted() + " transcripts mounted");
await key("Enter", { shiftKey: true }, 800);
expect(mounted() === 2, "unzoom did not restore both transcripts, got " + mounted());
// End zoomed on the second pane for the screenshot.
await key("Enter", { shiftKey: true }, 800);
expect(mounted() === 1, "second zoom did not release the other transcript");
