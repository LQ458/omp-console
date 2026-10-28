// Queue chips: prompts sent while a turn runs show as chips; remove calls the dequeue op with the chip's index.
// (The mock room queues every prompt sent during a turn, the first one too, so three chips.)
await open("pane-1");
await send("first prompt starts the scripted turn", 120);
await send("second prompt waits in the queue", 120);
await send("third prompt also waits", 120);
await sleep(1500);
const chipTexts = () => [...document.querySelectorAll(".qc-chip")].map(chip => chip.textContent ?? "");
const before = chipTexts();
expect(before.length === 3, "expected 3 queue chips, got " + before.length + ": " + JSON.stringify(before));
expect(before[1]?.includes("second prompt"), "chip 2 should carry the second prompt's text: " + before[1]);
expect(before[2]?.includes("third prompt"), "chip 3 should carry the third prompt's text: " + before[2]);
document.querySelectorAll(".qc-remove")[1]?.click();
await sleep(800);
const ops = await (await fetch("/api/mock/panes/ops")).json();
const last = ops[ops.length - 1];
expect(last && last.sessionId === "pane-1" && last.op.op === "dequeue" && last.op.index === 1, "dequeue not sent as {index: 1}: " + JSON.stringify(last));
expect(!chipTexts().some(text => text.includes("second prompt")), "the removed chip is still shown");
