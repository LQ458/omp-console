// Browser probe for the built omp-console PWA. One JS expression evaluated in the page; returns problem strings.
//
//   cd packages/web && bun run build && bun dev/mock-daemon.ts --port 7490 --dist dist &
//   omp-sweep --url http://127.0.0.1:7490/ --probe-file pwa/verify/probe.js --probe-only \
//     --widths 390 --themes dark --wait-ms 1500 --out /tmp/omp-console-pwa-sweep
//
// An empty problem list means: manifest parsed with installable fields and loadable icons, the service
// worker registered, activated and controls the page, the shell cache holds exactly the build's precache
// list, `/api` GETs go through the worker's network-first cache, and the relay path is not cached.
// Expected sweep noise: exactly one console error, the relay's 404 for the made-up room `probe-room`.
// `relay_probe.py` in this folder proves the worker does not answer `/r/*` and POSTs, and that the
// shell and `/api` still work offline.
(async () => {
	const problems = [];
	const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

	const link = document.querySelector('link[rel="manifest"]');
	if (!link) {
		problems.push("no <link rel=manifest>");
	} else {
		const response = await fetch(link.href);
		const manifest = await response.json().catch(() => null);
		if (!manifest) problems.push("manifest is not JSON");
		else {
			if (manifest.display !== "standalone") problems.push(`display=${manifest.display}`);
			if (manifest.name !== "omp console") problems.push(`name=${manifest.name}`);
			for (const icon of manifest.icons ?? []) {
				const image = await fetch(icon.src);
				if (!image.ok || !(image.headers.get("content-type") ?? "").startsWith("image/png")) {
					problems.push(`icon ${icon.src}: HTTP ${image.status} ${image.headers.get("content-type")}`);
				}
			}
		}
	}

	if (!("serviceWorker" in navigator)) return [...problems, "no serviceWorker in navigator"];
	const registration = await Promise.race([navigator.serviceWorker.ready, sleep(8000).then(() => null)]);
	if (!registration) return [...problems, "service worker never became ready"];
	if (!registration.active || !registration.active.scriptURL.endsWith("/sw.js")) problems.push("active worker is not /sw.js");
	if (registration.scope !== `${location.origin}/`) problems.push(`scope=${registration.scope}`);

	for (let i = 0; i < 50 && !navigator.serviceWorker.controller; i++) await sleep(100);
	if (!navigator.serviceWorker.controller) problems.push("page is not controlled by the service worker");

	const precache = await (await fetch("/precache-manifest.json", { cache: "no-store" })).json();
	const shellCache = `omp-console-shell-${precache.version}`;
	const names = await caches.keys();
	if (!names.includes(shellCache)) problems.push(`missing cache ${shellCache}; have ${names.join(",")}`);
	else {
		const keys = (await (await caches.open(shellCache)).keys()).map(r => new URL(r.url).pathname).sort();
		const expected = [...precache.precache].sort();
		if (JSON.stringify(keys) !== JSON.stringify(expected)) problems.push(`shell cache ${keys.length} entries differ from precache list ${expected.length}`);
	}

	// Network-first /api: the answer arrives and is mirrored into the API cache.
	const health = await fetch("/api/health");
	if (!health.ok) problems.push(`/api/health HTTP ${health.status}`);
	await sleep(200);
	const apiCache = await caches.open("omp-console-api-v1");
	if (!(await apiCache.match("/api/health"))) problems.push("/api/health was not cached by the worker");

	// The relay path must stay out of every worker cache.
	await fetch("/r/probe-room").catch(() => null);
	await sleep(200);
	if (await caches.match("/r/probe-room")) problems.push("/r/* ended up in a cache");

	return problems;
})()
