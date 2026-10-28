/**
 * Plugins and extension UI of a live session:
 *
 *   GET  /api/sessions/:id/plugins                       -> ListPluginsResponse
 *   POST /api/sessions/:id/plugins/:pluginId/enable      -> 204
 *   POST /api/sessions/:id/plugins/:pluginId/disable     -> 204
 *   GET  /api/sessions/:id/ext-ui                        -> ExtensionUiState (the newest whole state, empty when none yet)
 *
 * `pluginId` is the id from the list (`skill:foo`, `mcp:bar`, `extension-module:baz`, `plugin:qux`), URL-encoded. The
 * worker toggles through omp's own manager and reloads the plugin state the way `/reload-plugins` does.
 */
import type { ListPluginsResponse } from "@omp-console/protocol";
import { json } from "../api";
import { decodeSegment, failure, methodNotAllowed, RouteError } from "../session-ops/http";
import type { PluginPorts } from "./ports";

const PLUGINS_ROUTE = /^\/api\/sessions\/([^/]+)\/plugins$/;
const TOGGLE_ROUTE = /^\/api\/sessions\/([^/]+)\/plugins\/([^/]+)\/(enable|disable)$/;
const EXT_UI_ROUTE = /^\/api\/sessions\/([^/]+)\/ext-ui$/;

export function createPluginRoutes(ports: PluginPorts): (req: Request, url: URL) => Promise<Response | undefined> {
	return async (req, url) => {
		const list = PLUGINS_ROUTE.exec(url.pathname);
		const toggle = TOGGLE_ROUTE.exec(url.pathname);
		const extUi = EXT_UI_ROUTE.exec(url.pathname);
		const match = list ?? toggle ?? extUi;
		if (!match) return undefined;
		try {
			const sessionId = decodeSegment(match[1]!);
			if (!sessionId) throw new RouteError("bad-request", "invalid session id");
			if (list) {
				if (req.method !== "GET") return methodNotAllowed(req, "GET");
				const body: ListPluginsResponse = { plugins: await ports.plugins(sessionId) };
				return json(200, body);
			}
			if (extUi) {
				if (req.method !== "GET") return methodNotAllowed(req, "GET");
				return json(200, ports.extensionUi(sessionId));
			}
			if (req.method !== "POST") return methodNotAllowed(req, "POST");
			const pluginId = decodeSegment(match[2]!);
			if (!pluginId) throw new RouteError("bad-request", "invalid plugin id");
			await ports.togglePlugin(sessionId, pluginId, match[3] === "enable");
			return new Response(null, { status: 204 });
		} catch (error) {
			return failure(error);
		}
	};
}
