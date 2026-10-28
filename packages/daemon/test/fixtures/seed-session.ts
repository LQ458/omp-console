/** Writes one persisted omp session into the agent dir given by PI_CODING_AGENT_DIR and prints {file,id}. */
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const cwd = process.argv[2];
if (!cwd) throw new Error("usage: seed-session.ts <cwd>");
const manager = SessionManager.create(cwd);
await manager.appendMessage({ role: "user", content: "seeded question", timestamp: Date.now() } as never);
await manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "seeded answer" }], timestamp: Date.now() } as never);
process.stdout.write(`${JSON.stringify({ file: manager.getSessionFile(), id: manager.getSessionId() })}\n`);
process.exit(0);
