await open("pane-1");
await splitRight();
expect(paneIds().length === 2, "Cmd+D did not add a pane");
expect(document.querySelector(".pn-frame[data-focused=true] .sh-connect, .pn-frame[data-focused=true] .dk-empty-main"), "new pane is not an empty home pane");
await open("pane-2");
const [a, b] = paneIds().map(rectOf);
expect(a && b && Math.abs(a.top - b.top) < 2 && b.left >= a.right - 2, "panes are not side by side");
expect(a && b && Math.abs(a.width - b.width) < 40, "split is not even");
expect(document.querySelectorAll(".sh-composer").length >= 1, "no composer after opening");
