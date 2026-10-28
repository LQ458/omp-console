/** Service worker entry: built to `/sw.js` by `scripts/build-pwa.ts`, which injects `__OMP_CONSOLE_SW_CONFIG__`. */
import { installServiceWorker, type SwConfig, type SwScope } from "./sw-core";

declare const __OMP_CONSOLE_SW_CONFIG__: SwConfig;

installServiceWorker(self as unknown as SwScope, __OMP_CONSOLE_SW_CONFIG__);
