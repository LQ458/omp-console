// Close after zoom: the remaining pane, the focused pane and the sidebar's selected row must agree.
await open("pane-1");
await splitRight();
await open("pane-2");
const [left, right] = paneIds();
expect(focusedPane() === right, "the new right pane should be focused");
await key("Enter", { shiftKey: true });
await key("Enter", { shiftKey: true });
await key("w");
const remaining = paneIds();
expect(remaining.length === 1 && remaining[0] === left, "Cmd+W should close the focused right pane, left " + JSON.stringify(remaining));
const shown = document.querySelector(".pn-frame .sh-title")?.textContent;
const selected = document.querySelector(".dk-item-wrap[data-selected=true] .dk-item-title")?.textContent
	?? document.querySelector(".dk-item-wrap[data-selected=true]")?.textContent;
expect(selected !== undefined && shown !== undefined && selected.includes(shown), "sidebar selects " + JSON.stringify(selected) + " but the pane shows " + JSON.stringify(shown));
