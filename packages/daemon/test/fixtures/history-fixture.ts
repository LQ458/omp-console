/**
 * Creates a persisted omp session, forks it (header `parentSession` = the parent's id) and prints what the history
 * area's default lister reads from disk as JSON. Run with an isolated PI_CODING_AGENT_DIR / PI_CONFIG_DIR.
 */
import { listPersisted } from "../../src/history/persisted";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const cwd = process.argv[2];
if (!cwd) throw new Error("usage: history-fixture.ts <cwd>");
const manager = SessionManager.create(cwd);
await manager.appendMessage({ role: "user", content: "parent question", timestamp: Date.now() } as never);
await manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "parent answer" }], timestamp: Date.now() } as never);
await manager.ensureOnDisk();
const parentId = manager.getSessionId();
const parentFile = manager.getSessionFile();
const forked = await manager.fork();
if (!forked) throw new Error("fork was refused");
await manager.appendMessage({ role: "user", content: "child question", timestamp: Date.now() } as never);
await manager.ensureOnDisk();
const childId = manager.getSessionId();
process.stdout.write(`${JSON.stringify({ parentId, parentFile, childId, listed: await listPersisted() })}\n`);
process.exit(0);
