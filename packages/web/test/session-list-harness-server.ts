import harness from "./session-list-harness.html";

const port = Number(process.env.PORT ?? 7761);
const server = Bun.serve({
	port,
	development: true,
	routes: {
		"/": harness,
	},
	fetch: () => new Response("not found", { status: 404 }),
});

console.log(`omp console session list harness on ${server.url}`);
