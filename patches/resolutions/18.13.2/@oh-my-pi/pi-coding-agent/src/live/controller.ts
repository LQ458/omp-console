# omp-sync-resolution v1
ours
--- patch ---
diff --git a/src/live/controller.ts b/src/live/controller.ts
--- a/src/live/controller.ts
+++ b/src/live/controller.ts
@@ -18,2 +18,3 @@
 import { CodexLiveTransport, type LiveTransportOptions } from "./transport";
+import { OUTPUT_ACTIVE_LEVEL, OutputActivity } from "./output-activity";
 import type { LivePhase } from "@oh-my-pi/pi-tui/apps/live-visualizer";
