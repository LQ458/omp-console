import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeDaemonUrl } from "../www/url.js";

const ok = (input, url) => assert.deepEqual(normalizeDaemonUrl(input), { ok: true, url });
const bad = input => assert.equal(normalizeDaemonUrl(input).ok, false, `expected rejection: ${input}`);

test("bare host gets https and a root path; query and fragment are dropped", () => {
	ok("  box.tailnet-example.ts.net ", "https://box.tailnet-example.ts.net/");
	ok("https://box.tailnet-example.ts.net:8443/deck?x=1#frag", "https://box.tailnet-example.ts.net:8443/deck");
});

test("plain http only for localhost and private IPv4, not for public or tailnet names", () => {
	ok("http://localhost:3000", "http://localhost:3000/");
	ok("http://10.0.2.2:8080", "http://10.0.2.2:8080/");
	ok("http://192.168.1.20", "http://192.168.1.20/");
	ok("http://172.31.0.1", "http://172.31.0.1/");
	bad("http://172.32.0.1");
	bad("http://8.8.8.8");
	bad("http://box.tailnet-example.ts.net");
	bad("http://192.168.1.256");
});

test("rejects credentials, other schemes, and empty input", () => {
	bad("https://user:pw@box.ts.net");
	bad("ftp://box.ts.net");
	bad("javascript://box.ts.net/%0aalert(1)");
	bad("");
	bad("https://");
});
