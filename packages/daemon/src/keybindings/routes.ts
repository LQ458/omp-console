import { json } from "../api";
import { failure, methodNotAllowed } from "../session-ops/http";
import type { KeybindingsPorts } from "./ports";

const KEYBINDINGS_ROUTE = "/api/keybindings";

export function createKeybindingsRoutes(ports: KeybindingsPorts): (req: Request, url: URL) => Promise<Response | undefined> {
	return async (req, url) => {
		if (url.pathname !== KEYBINDINGS_ROUTE) return undefined;
		try {
			if (req.method !== "GET") return methodNotAllowed(req, "GET");
			return json(200, await ports.keybindings());
		} catch (error) {
			return failure(error);
		}
	};
}
