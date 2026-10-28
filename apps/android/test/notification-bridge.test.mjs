import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const shim = readFileSync(new URL("../android/app/src/main/assets/deck-android-shim.js", import.meta.url), "utf8");
const origin = "https://omp-console.example";
const sessionUrl = `${origin}/#session=session-1`;
const token = "A".repeat(43);

function makeBridge(fetch) {
	const messages = [];
	const opened = [];
	const window = {
		OmpConsoleAndroidNative: { postMessage: value => messages.push(JSON.parse(value)) },
		location: { origin, href: sessionUrl, assign: value => opened.push(value) },
	};
	runInNewContext(shim, { window, document: {}, URL, fetch });
	return { window, messages, opened };
}

test("notify forwards up to three same-origin answer actions to the native bridge", () => {
	const bridge = makeBridge(() => Promise.resolve(new Response(null, { status: 204 })));
	assert.equal(
		bridge.window.OmpConsoleAndroid.notify("Waiting", "Choose", "session-1:needs-answer", [
			{ title: "Approve", value: "Approve", token, url: sessionUrl },
			{ title: "Deny", value: "Deny", token, url: sessionUrl },
		]),
		true,
	);
	assert.deepEqual(bridge.messages[0].actions, [
		{ title: "Approve", value: "Approve", token, url: sessionUrl },
		{ title: "Deny", value: "Deny", token, url: sessionUrl },
	]);
});

test("notify omits answer actions when any target leaves the daemon origin", () => {
	const bridge = makeBridge(() => Promise.resolve(new Response(null, { status: 204 })));
	bridge.window.OmpConsoleAndroid.notify("Waiting", "Choose", "tag", [
		{ title: "Approve", value: "Approve", token, url: "https://evil.example/" },
	]);
	assert.equal(bridge.messages[0].actions, undefined);
});

test("a native answer posts the exact choice with same-origin credentials and confirms success", async () => {
	let sent;
	const bridge = makeBridge(async (url, init) => {
		sent = { url, init };
		return new Response(null, { status: 204 });
	});
	await bridge.window.__ompConsoleAndroidAnswerAction(token, "Approve", sessionUrl);
	assert.equal(sent.url, "/api/push/answer");
	assert.equal(sent.init.method, "POST");
	assert.equal(sent.init.credentials, "same-origin");
	assert.deepEqual(JSON.parse(sent.init.body), { token, value: "Approve" });
	assert.equal(bridge.messages[0].body, "Answer sent");
});

test("a rejected answer opens its session, while a cross-origin URL is ignored", async () => {
	const bridge = makeBridge(() => Promise.resolve(new Response(null, { status: 409 })));
	await bridge.window.__ompConsoleAndroidAnswerAction(token, "Approve", sessionUrl);
	assert.deepEqual(bridge.opened, [sessionUrl]);

	await bridge.window.__ompConsoleAndroidAnswerAction(token, "Approve", "https://evil.example/");
	assert.deepEqual(bridge.opened, [sessionUrl]);
});
