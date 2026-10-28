// Runs before `bun run build`. Bun 1.2.19 bundled this app with the wrong entry chunk in index.html
// (a blank page), so refuse to build with anything older than 1.4.
const [major = 0, minor = 0] = Bun.version.split(".").map(Number);
if (major < 1 || (major === 1 && minor < 4)) {
	console.error(`Bun ${Bun.version} cannot build the web UI correctly; Bun 1.4 or newer is required (run \`bun upgrade\`).`);
	process.exit(1);
}
