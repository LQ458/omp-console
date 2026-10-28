import * as path from "node:path";

const root = path.resolve(import.meta.dir, "../ui");
const mimeTypes: Record<string, string> = {
	".css": "text/css; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
};

Bun.serve({
	hostname: "127.0.0.1",
	port: 1420,
	fetch(request) {
		const pathname = new URL(request.url).pathname;
		const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
		const file = path.resolve(root, relative);
		if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
			return new Response("Not found", { status: 404 });
		}
		const type = mimeTypes[path.extname(file)];
		if (!type) return new Response("Not found", { status: 404 });
		return new Response(Bun.file(file), { headers: { "content-type": type } });
	},
});
