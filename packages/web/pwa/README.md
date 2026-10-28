# omp-console PWA

Installable Home Screen app and Web Push for the omp console web UI.

| File | Role |
|---|---|
| `sw.ts` / `sw-core.ts` | service worker (built to `/sw.js`); logic is written against a minimal scope so tests run it on a fake `self` |
| `push.ts` | `isStandalone`, `pushSupported`, `enablePush` (gesture only), `disablePush`, `sendTestPush`, `getPushState`, `syncPushSubscription` |
| `EnableNotifications.tsx` | button and states: unsupported, install hint, denied, off, enabled (+ test, turn off) |
| `messages.ts` | messages the worker posts to pages (`omp-console:push`, `omp-console:open`) |
| `icons/` | deterministic vector-to-PNG generator: `bun pwa/icons/generate.ts` rewrites `public/` icons and `favicon.svg` |
| `../scripts/build-pwa.ts` | `postbuild`: stable manifest and icons into `dist/`, precache list, versioned `sw.js` |
| `verify/` | `probe.js` (omp-sweep) and `relay_probe.py` (Playwright) browser checks |

## Worker policy

- Precache: the hashed shell plus manifest and icons into `omp-console-shell-<content hash>`. Navigations get the cached `/`. No `skipWaiting`: a new worker waits until every omp console window is closed, so an update applies on the next launch and never swaps assets under an open page (verified in Chromium, see below). Old `omp-console-*` caches are deleted on activate; foreign caches are left alone.
- `/api/*` GET: network first, a 200 answer refreshes `omp-console-api-v1`, offline falls back to it. Errors (401, 5xx) are passed through, never cached.
- Never touched: `/r/*` (relay), non-GET, range, cross-origin requests.
- Push: every push shows a notification, because WebKit revokes a subscription whose pushes are not user visible ("Violations of the `userVisibleOnly` promise will result in a push subscription being revoked", webkit.org/blog/12945). When an omp console window is visible it also gets an `omp-console:push` message and the notification is shown with `silent: true`. A repeated tag (`<sessionId>:<reason>`) replaces the notification on screen. A tap focuses an open window and navigates it to `data.url`, or opens one.

## iPhone

Install: Safari, Share, Add to Home Screen, open from the Home Screen icon. Keep **Open as Web App** on (iOS 26 shows the switch); with it off the app is a plain web page and has no push. Then tap Enable notifications inside the app (the permission prompt needs the tap).

## Verify

```sh
cd packages/web && bun run build && bun dev/mock-daemon.ts --port 7490 --dist dist &
omp-sweep --url http://127.0.0.1:7490/ --probe-file pwa/verify/probe.js --probe-only --widths 390 --themes dark --wait-ms 1500
python3 pwa/verify/relay_probe.py http://127.0.0.1:7490
bun test pwa
tsgo -p pwa/tsconfig.json --noEmit
```

Not verifiable without an iPhone: the Add to Home Screen flow and icon rendering, iOS's permission prompt, a real APNs delivery, behaviour with "Open as Web App" off, `pushsubscriptionchange` (Safari rarely fires it; `syncPushSubscription` covers a missed one at launch), and the `black` status-bar style against the app's top bar.
