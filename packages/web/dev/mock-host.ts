/**
 * Offline mock collab host: starts the local relay, opens one scripted room as host, and prints
 * the join link.
 *
 *   bun dev/mock-host.ts [--port 7466]
 */

import { startMockRoom } from "./mock-room";
import { startLocalRelay } from "./local-relay";

const DEFAULT_PORT = 7466;

function parsePort(argv: string[]): number {
	let raw: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--port") raw = argv[i + 1];
		else if (arg.startsWith("--port=")) raw = arg.slice("--port=".length);
	}
	if (raw === undefined) return DEFAULT_PORT;
	const port = Number(raw);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		console.error(`mock-host: invalid --port ${raw}`);
		process.exit(1);
	}
	return port;
}

const relay = startLocalRelay(parsePort(Bun.argv.slice(2)));
const room = await startMockRoom({
	relayUrl: relay.url,
	log: message => console.log(`mock-host: ${message}`),
	onLost: reason => {
		console.error(`mock-host: ${reason}`);
		relay.stop();
		process.exit(1);
	},
});
await room.ready;
console.log("mock collab host ready");
console.log(`join link: ${room.linkFor(relay.url)}`);
console.log("paste the link into the connect screen (bun run dev), Ctrl+C stops the host");

process.on("SIGINT", () => {
	console.log("\nmock-host: shutting down");
	void room.stop().finally(() => {
		relay.stop();
		process.exit(0);
	});
});
