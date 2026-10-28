import { describe, expect, it } from "bun:test";
import type { KeybindingsResponse } from "@omp-console/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { KeybindingsSheet } from "../src/components/keys/KeybindingsSheet";
import { withDeckKeybindingDefaults } from "../src/lib/keymap";
const keybindings: KeybindingsResponse = {
	bindings: {
		"app.interrupt": ["escape"],
		"app.tools.expand": ["ctrl+shift+e"],
		"app.unknown": ["alt+x"],
		"app.unbound": [],
	},
	doubleEscapeAction: "rewind",
};

describe("keyboard shortcuts sheet", () => {
	it("shows configured actions and the omp console pause fallback", () => {
		const html = renderToStaticMarkup(
			<KeybindingsSheet keybindings={withDeckKeybindingDefaults(keybindings)} error={null} onClose={() => {}} />,
		);
		expect(html).toContain("Interrupt session");
		expect(html).toContain("ctrl+shift+e");
		expect(html).toContain("app.unknown");
		expect(html).not.toContain("app.unbound");
		expect(html).toContain("Pause goal");
		expect(html).toContain("alt+shift+g");
		expect(html).toContain("rewind to a message");
	});
});
