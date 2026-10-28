import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsSheet } from "../src/components/shell/SettingsSheet";
import { DeckApi } from "../src/lib/api";

const noop = (): void => {};
const api = new DeckApi({ fetch: async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }) });

describe("settings scope", () => {
	it("shows basics first and keeps advanced controls collapsed", () => {
		const html = renderToStaticMarkup(
			<SettingsSheet
				scope="global"
				onClose={noop}
				canLeave
				onLeave={noop}
				api={api}
				sessionId="must-not-leak"
			/>,
		);
		expect(html).toContain("Basics");
		expect(html).toContain("Notifications");
		expect(html).toContain("Appearance");
		const order = [
			html.indexOf(">Appearance</h3>"),
			html.indexOf(">Notifications</h3>"),
			html.indexOf("Pair another device"),
			html.indexOf(">Model roles</h3>"),
		];
		expect(order.every(index => index >= 0)).toBe(true);
		expect(order[0]).toBeLessThan(order[1]!);
		expect(order[1]).toBeLessThan(order[2]!);
		expect(order[2]).toBeLessThan(order[3]!);
		expect(html).toContain("Pair another device");
		expect(html).toContain("Model roles");
		expect(html).toContain("Get started");
		expect(html).toContain("Import from Claude Code");
		expect(html).toMatch(/<details class="dk-settings-advanced"><summary>Advanced<\/summary>/);
		expect(html).not.toContain("Optional features");
		expect(html).not.toContain("Offline cache");
		expect(html).not.toContain("Overnight run");
		expect(html).not.toContain("Open session settings");
		expect(html).not.toContain("session settings navigation");
		expect(html).not.toContain("Leave this session");
		expect(html).not.toContain('aria-label="session settings sections"');
		expect(html).not.toContain("must-not-leak");
	});

	it("keeps session actions and plugin access in the session panel", () => {
		const html = renderToStaticMarkup(
			<SettingsSheet
				scope="session"
				onClose={noop}
				canLeave
				onLeave={noop}
				api={api}
				sessionId="session-1"
				onOpenGlobalSettings={noop}
			/>,
		);
		expect(html).toContain("Session settings");
		expect(html).toContain("Leave this session");
		expect(html).toContain(">Plugins</button>");
		expect(html).toContain("Global settings");
		expect(html).not.toContain("Notifications");
		expect(html).not.toContain("Model roles");
		expect(html).not.toContain("Offline cache");
	});
});
