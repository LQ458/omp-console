import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NotificationsView, type NotificationsViewProps } from "../EnableNotifications";

const noop = () => {};
const base: NotificationsViewProps = {
	status: "off",
	busy: false,
	message: null,
	messageIsError: false,
	onEnable: noop,
	onDisable: noop,
	onTest: noop,
};

const render = (props: Partial<NotificationsViewProps>) => renderToStaticMarkup(<NotificationsView {...base} {...props} />);

describe("NotificationsView", () => {
	it("tells iPhone users to install and to keep Open as Web App on", () => {
		const html = render({ status: "install-required" });
		expect(html).toContain("Add to Home Screen");
		expect(html).toContain("Open as Web App");
		expect(html).not.toContain("<button");
	});

	it("offers exactly the action each state allows", () => {
		expect(render({ status: "off" })).toContain("Enable notifications");
		const enabled = render({ status: "enabled" });
		expect(enabled).toContain("Send test");
		expect(enabled).toContain("Turn off");
		expect(enabled).not.toContain("Enable notifications");
		for (const status of ["unsupported", "denied"] as const) expect(render({ status })).not.toContain("<button");
	});

	it("disables the buttons while a request is running and exposes errors as alerts", () => {
		const html = render({ status: "off", busy: true, message: "Could not reach the daemon.", messageIsError: true });
		expect(html).toContain("disabled");
		expect(html).toContain('role="alert"');
	});
});
