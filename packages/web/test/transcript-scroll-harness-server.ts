import harness from "./transcript-scroll-harness.html";

const port = Number(process.env.PORT ?? 7654);
const server = Bun.serve({
	port,
	development: true,
	routes: { "/": harness },
	fetch: () => new Response("not found", { status: 404 }),
});

console.log(`transcript scroll harness on ${server.url}`);
