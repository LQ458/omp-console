import harness from "./motion-harness.html";

const port = Number(process.env.PORT ?? 7760);
const server = Bun.serve({
	port,
	development: true,
	routes: {
		"/": harness,
	},
	fetch: () => new Response("not found", { status: 404 }),
});

console.log(`deck motion harness on ${server.url}`);
