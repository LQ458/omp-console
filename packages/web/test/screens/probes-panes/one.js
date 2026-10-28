await open("pane-1");
expect(paneIds().length === 1, "expected one pane, got " + paneIds().length);
expect(document.querySelector(".pn-bar"), "no pane bar");
expect(document.querySelector(".sh-composer"), "no composer in the pane");
