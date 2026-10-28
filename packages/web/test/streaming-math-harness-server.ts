import harness from "./streaming-math-harness.html";

const port = Number(process.env.PORT ?? 7653);
const server = Bun.serve({
	port,
	development: true,
	routes: { "/": harness },
	fetch: () => new Response("not found", { status: 404 }),
});

console.log(`streaming math harness on ${server.url}`);
