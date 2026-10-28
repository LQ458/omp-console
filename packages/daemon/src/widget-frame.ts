/**
 * `GET /widget-frame.html`: the page an interactive transcript widget (a ```widget fence, packages/web/src/transcript/
 * figures.ts) runs in. The web UI frames it with `sandbox="allow-scripts"` (an opaque origin: no omp-console cookies,
 * storage or API) and posts it the widget document, which it writes over itself.
 *
 * It is served apart from the static web so it can carry its own policy. The UI's CSP (`script-src 'self'`,
 * `frame-ancestors 'none'`) would forbid the widget's inline scripts and the framing itself; this one allows inline
 * script and style and nothing that reaches the network (`default-src 'none'`: no fetch, XHR, WebSocket, external
 * image, font, or nested frame), and only omp console itself may frame it.
 */
export const WIDGET_FRAME_PATH = "/widget-frame.html";

const WIDGET_FRAME_CSP = [
	"default-src 'none'",
	"script-src 'unsafe-inline'",
	"style-src 'unsafe-inline'",
	"img-src data: blob:",
	"font-src data:",
	"media-src data: blob:",
	"base-uri 'none'",
	"form-action 'none'",
	"frame-ancestors 'self'",
].join("; ");

/** Waits for the parent's document, then replaces itself with it; anything not from the parent is ignored. */
const WIDGET_FRAME_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
addEventListener("message", function onMessage(event) {
	if (event.source !== parent || !event.data || typeof event.data.deckWidgetDocument !== "string") return;
	removeEventListener("message", onMessage);
	document.open();
	document.write(event.data.deckWidgetDocument);
	document.close();
});
parent.postMessage({ deckWidgetFrame: "ready" }, "*");
</script></body></html>`;

export function widgetFrameResponse(): Response {
	return new Response(WIDGET_FRAME_HTML, {
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Content-Security-Policy": WIDGET_FRAME_CSP,
			"X-Content-Type-Options": "nosniff",
			"Referrer-Policy": "no-referrer",
			"Cache-Control": "no-cache",
		},
	});
}
