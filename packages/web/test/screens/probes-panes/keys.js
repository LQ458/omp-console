// Focus and move by geometry, close, and the last pane closing to the home screen. Checks only; the screenshot is incidental.
await open("pane-1");
await splitRight();
await open("pane-2");
await splitDown();
await open("pane-3");
const before = paneIds();
expect(before.length === 3, "expected 3 panes");
const [a, b, c] = before; // a: left, b: top right, c: bottom right
expect(focusedPane() === c, "new pane should be focused");
await focusDir("Up");
expect(focusedPane() === b, "Cmd+Opt+Up from the bottom right should reach the top right, got " + focusedPane());
await focusDir("Left");
expect(focusedPane() === a, "Cmd+Opt+Left should reach the left pane, got " + focusedPane());
await focusDir("Left");
expect(focusedPane() === a, "focus must stay at the edge");
// Move (swap) the left pane's session to the right.
const titleOf = id => document.querySelector(`.pn-frame[data-pane="${id}"] .sh-title`)?.textContent;
const leftTitle = titleOf(a);
await moveDir("Right");
await sleep(500);
expect(titleOf(b) === leftTitle, "Cmd+Shift+Right should move the left session to the right pane");
expect(focusedPane() === b, "focus should follow the moved session");
// Close the focused pane, then the rest down to the home screen.
await key("w");
expect(paneIds().length === 2, "Cmd+W did not close the pane");
await key("w");
await key("w");
expect(paneIds().length === 1, "the last pane must stay");
expect(document.querySelector(".pn-frame .dk-empty-main"), "last pane did not return to the home screen");
