/**
 * Dev server: Bun's HTML dev server (HMR) for the SPA, with `/api` and `/r` (relay WebSockets)
 * proxied to a daemon. The production daemon serves the built assets on the same origin, so the
 * app only ever uses relative URLs.
 *
 *   OMP_CONSOLE_DAEMON_URL=http://127.0.0.1:7467 PORT=3000 bun dev/dev-server.ts
 *
 * Start `bun run mock-daemon` first to develop without the real daemon.
 */
import index from "../index.html";

const DAEMON_URL = new URL(process.env.OMP_CONSOLE_DAEMON_URL ?? "http://127.0.0.1:7467");
const PORT = Number(process.env.PORT ?? 3000);

interface ProxyData {
	upstreamUrl: string;
	upstream: WebSocket | null;
	/** Client frames received before the upstream socket opened. */
	queued: (string | Uint8Array<ArrayBuffer>)[];
}

/** WebSocket close codes an endpoint may send; anything else (1005/1006/…) is replaced. */
function sendableCode(code: number): number {
	return code === 1000 || (code >= 3000 && code <= 4999) ? code : 1011;
}

async function proxyHttp(req: Request): Promise<Response> {
	const url = new URL(req.url);
	const target = new URL(url.pathname + url.search, DAEMON_URL);
	const headers = new Headers(req.headers);
	headers.set("x-forwarded-host", url.host);
	headers.set("x-forwarded-proto", url.protocol.replace(":", ""));
	headers.delete("host");
	const hasBody = req.method !== "GET" && req.method !== "HEAD";
	try {
		return await fetch(target, {
			method: req.method,
			headers,
			body: hasBody ? await req.arrayBuffer() : undefined,
			redirect: "manual",
		});
	} catch {
		return Response.json({ error: `daemon unreachable at ${DAEMON_URL.origin}`, code: "internal" }, { status: 502 });
	}
}

const server = Bun.serve<ProxyData>({
	port: PORT,
	development: true,
	routes: {
		"/": index,
		"/api/*": proxyHttp,
		"/r/*": (req: Request, srv: Bun.Server<ProxyData>) => {
			const url = new URL(req.url);
			const upstreamUrl = `${DAEMON_URL.protocol === "https:" ? "wss" : "ws"}://${DAEMON_URL.host}${url.pathname}${url.search}`;
			if (srv.upgrade(req, { data: { upstreamUrl, upstream: null, queued: [] } })) return undefined;
			return new Response("websocket upgrade required", { status: 426 });
		},
	},
	fetch: () => new Response("not found", { status: 404 }),
	websocket: {
		open(ws) {
			const upstream = new WebSocket(ws.data.upstreamUrl);
			upstream.binaryType = "arraybuffer";
			ws.data.upstream = upstream;
			upstream.onopen = () => {
				for (const message of ws.data.queued) upstream.send(message);
				ws.data.queued.length = 0;
			};
			upstream.onmessage = event => {
				const data: unknown = event.data;
				if (typeof data === "string") ws.send(data);
				else if (data instanceof ArrayBuffer) ws.send(new Uint8Array(data));
			};
			upstream.onclose = event => ws.close(sendableCode(event.code), event.reason);
		},
		message(ws, message) {
			const frame = typeof message === "string" ? message : new Uint8Array(message);
			const upstream = ws.data.upstream;
			if (upstream?.readyState === WebSocket.OPEN) upstream.send(frame);
			else ws.data.queued.push(frame);
		},
		close(ws) {
			ws.data.upstream?.close();
		},
	},
});

console.log(`deck web dev server on ${server.url} → daemon ${DAEMON_URL.origin}`);
