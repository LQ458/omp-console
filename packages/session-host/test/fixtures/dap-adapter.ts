let input = Buffer.alloc(0);
let nextSequence = 1;
let line = 1;
let targetProgram = "sample.js";
if (process.env.OMP_CONSOLE_DAP_FIXTURE_IGNORE_SIGTERM === "1") process.on("SIGTERM", () => {});

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function send(message: Record<string, unknown>): void {
	const body = JSON.stringify(message);
	process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function respond(request: Record<string, unknown>, body: Record<string, unknown> = {}): void {
	if (typeof request.seq !== "number" || typeof request.command !== "string") return;
	send({ seq: nextSequence++, type: "response", request_seq: request.seq, command: request.command, success: true, body });
}

function event(name: string, body: Record<string, unknown>): void {
	send({ seq: nextSequence++, type: "event", event: name, body });
}

function handle(request: Record<string, unknown>): void {
	const command = request.command;
	switch (command) {
		case "initialize":
			if (process.env.OMP_CONSOLE_DAP_FIXTURE_HOLD_INITIALIZE === "1") {
				Bun.spawn([process.execPath, "-e", "setTimeout(()=>{}, 1e9)", "omp-console-dap-fixture-child"], {
					stdin: "ignore",
					stdout: "ignore",
					stderr: "ignore",
					windowsHide: true,
				});
				return;
			}
			respond(request, {
				supportsConfigurationDoneRequest: true,
				supportsEvaluateForHovers: true,
				supportsTerminateRequest: true,
			});
			event("initialized", {});
			return;
		case "launch":
		case "attach": {
			const args = isRecord(request.arguments) ? request.arguments : {};
			if (typeof args.program === "string") targetProgram = args.program;
			respond(request);
			event("output", { category: "stdout", output: "DAP fixture ready\n" });
			event("stopped", { reason: "entry", threadId: 1, allThreadsStopped: true });
			return;
		}
		case "threads":
			respond(request, { threads: [{ id: 1, name: "main thread" }] });
			return;
		case "stackTrace":
			respond(request, {
				stackFrames: [{ id: 1, name: "main", line, column: 1, source: { name: targetProgram.split(/[\\/]/).at(-1) ?? "sample.js", path: targetProgram } }],
				totalFrames: 1,
			});
			return;
		case "scopes":
			respond(request, { scopes: [{ name: "Locals", variablesReference: 10, expensive: false }] });
			return;
		case "variables":
			respond(request, { variables: [{ name: "answer", value: "42", type: "number", variablesReference: 0 }] });
			return;
		case "evaluate":
			respond(request, { result: "42", type: "number", variablesReference: 0 });
			return;
		case "continue":
			respond(request, { allThreadsContinued: true });
			event("continued", { threadId: 1, allThreadsContinued: true });
			return;
		case "next":
		case "stepIn":
		case "stepOut":
		case "pause":
			line += 1;
			respond(request);
			event("stopped", { reason: command === "pause" ? "pause" : "step", threadId: 1, allThreadsStopped: true });
			return;
		case "terminate":
			respond(request);
			event("terminated", {});
			return;
		case "disconnect":
			respond(request);
			return;
		case "configurationDone":
		case "setExceptionBreakpoints":
			respond(request);
			return;
		case "setBreakpoints":
			respond(request, { breakpoints: [] });
			return;
		default:
			respond(request);
	}
}

function readMessages(): void {
	for (;;) {
		const boundary = input.indexOf("\r\n\r\n");
		if (boundary < 0) return;
		const header = input.subarray(0, boundary).toString("ascii");
		const length = /^Content-Length:\s*(\d+)\s*$/im.exec(header)?.[1];
		if (length === undefined) {
			process.stderr.write("DAP fixture received a frame without Content-Length.\n");
			process.exitCode = 1;
			return;
		}
		const bodyLength = Number(length);
		if (!Number.isSafeInteger(bodyLength) || bodyLength < 0 || bodyLength > 1_048_576) {
			process.stderr.write("DAP fixture received an invalid Content-Length.\n");
			process.exitCode = 1;
			return;
		}
		const bodyStart = boundary + 4;
		if (input.length < bodyStart + bodyLength) return;
		const body = input.subarray(bodyStart, bodyStart + bodyLength).toString("utf8");
		input = input.subarray(bodyStart + bodyLength);
		try {
			const message: unknown = JSON.parse(body);
			if (isRecord(message) && message.type === "request") handle(message);
		} catch (cause) {
			process.stderr.write(`DAP fixture could not parse a request: ${String(cause)}\n`);
			process.exitCode = 1;
			return;
		}
	}
}

process.stdin.on("data", (chunk: Uint8Array) => {
	input = Buffer.concat([input, Buffer.from(chunk)]);
	readMessages();
});
