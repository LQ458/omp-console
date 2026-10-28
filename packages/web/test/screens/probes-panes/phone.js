await open("pane-1");
await splitRight();
await open("pane-2");
expect(document.querySelector(".pn-phone-bar"), "no phone pane switcher");
expect(document.querySelectorAll(".pn-phone-tab").length === 2, "switcher should list two panes");
expect(!document.querySelector(".pn-bar"), "phone must not show the split bar");
expect(paneIds().length === 1, "phone shows more than one pane at once");
