import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LaunchError, parseForkSpec, parseLaunch, parseLaunchSecrets } from "../src/launch";

let dir: string;
let sessionFile: string;
const roomId = randomBytes(16).toString("base64url");
const secrets = {
	t: "launch" as const,
	roomKey: randomBytes(32).toString("base64url"),
	writeToken: randomBytes(16).toString("base64url"),
	deviceToken: randomBytes(32).toString("base64url"),
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-launch-"));
	sessionFile = path.join(dir, "session.jsonl");
	fs.writeFileSync(sessionFile, "{}\n");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const base = () => ["--cwd", dir, "--relay", "ws://127.0.0.1:7466", "--room", roomId];

describe("launch contract", () => {
	test("decodes launch secrets from the first stdin line and keeps them out of argv", () => {
		const launch = parseLaunch([...base(), "--model", "stub/stub-model"], secrets);
		expect(Buffer.from(launch.roomKey).toString("base64url")).toBe(secrets.roomKey);
		expect(Buffer.from(launch.writeToken).toString("base64url")).toBe(secrets.writeToken);
		expect(launch.deviceToken).toBe(secrets.deviceToken);
		expect(launch.roomId).toBe(roomId);
		expect(launch.model).toBe("stub/stub-model");
		expect(launch.resumeFile).toBeUndefined();
	});

	test("rejects malformed launch secrets and values of the wrong size", () => {
		expect(() => parseLaunchSecrets("{not json")).toThrow(LaunchError);
		expect(() => parseLaunchSecrets(JSON.stringify({ t: "other", roomKey: "x", writeToken: "y" }))).toThrow(
			LaunchError,
		);
		expect(() => parseLaunch(base(), { ...secrets, roomKey: randomBytes(16).toString("base64url") })).toThrow(
			LaunchError,
		);
		expect(() => parseLaunch(base(), { ...secrets, writeToken: randomBytes(32).toString("base64url") })).toThrow(
			LaunchError,
		);
		expect(() => parseLaunch(base(), { ...secrets, deviceToken: randomBytes(16).toString("base64url") })).toThrow(LaunchError);
	});

	test("rejects a room id the host could not reproduce", () => {
		for (const bad of ["short", `${roomId}A`, `${roomId.slice(0, -1)}!`]) {
			expect(() => parseLaunch(["--cwd", dir, "--relay", "ws://x:1", "--room", bad], secrets)).toThrow(LaunchError);
		}
	});

	test("resume and fork are exclusive, and their files must exist", () => {
		expect(() => parseLaunch([...base(), "--resume", sessionFile, "--fork", sessionFile], secrets)).toThrow(
			"mutually exclusive",
		);
		expect(() => parseLaunch([...base(), "--resume", path.join(dir, "missing.jsonl")], secrets)).toThrow(LaunchError);
		expect(parseLaunch([...base(), "--resume", sessionFile], secrets).resumeFile).toBe(sessionFile);
	});

	test("fork spec splits an entry id off the path but never splits a path that exists as given", () => {
		expect(parseForkSpec(`${sessionFile}:entry-7`)).toEqual({ sessionFile, entryId: "entry-7" });
		expect(parseForkSpec(sessionFile)).toEqual({ sessionFile });
		const colonPath = path.join(dir, "a:b.jsonl");
		fs.writeFileSync(colonPath, "{}\n");
		expect(parseForkSpec(colonPath)).toEqual({ sessionFile: colonPath });
	});

	test("unknown flags and non-URL relays fail fast", () => {
		expect(() => parseLaunch([...base(), "--chdir", "/"], secrets)).toThrow("unknown argument");
		expect(() => parseLaunch(["--cwd", dir, "--relay", "not a url", "--room", roomId], secrets)).toThrow(LaunchError);
	});
});
