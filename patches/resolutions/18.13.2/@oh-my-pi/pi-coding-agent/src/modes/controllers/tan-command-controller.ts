# omp-sync-resolution v1
ours
ours
--- patch ---
diff --git a/src/modes/controllers/tan-command-controller.ts b/src/modes/controllers/tan-command-controller.ts
--- a/src/modes/controllers/tan-command-controller.ts
+++ b/src/modes/controllers/tan-command-controller.ts
@@ -47,6 +47,6 @@
-	async start(work: string): Promise<{ jobId: string; agentId: string } | undefined> {
+	async start(work: string, images?: ImageContent[]): Promise<{ jobId: string; agentId: string } | undefined> {
 		const trimmedWork = work.trim();
 		if (!trimmedWork) {
 			this.ctx.showStatus("Usage: /tan <work>");
-			return false;
+			return undefined;
 		}
@@ -57,4 +57,4 @@
 		if (!model) {
 			this.ctx.showError("No active model available for /tan.");
-			return false;
+			return undefined;
 		}
@@ -63,4 +63,4 @@
 		if (!manager) {
 			this.ctx.showError("Background jobs are disabled; enable async jobs to use /tan.");
-			return false;
+			return undefined;
 		}
@@ -69,4 +69,4 @@
 		if (!parentFile) {
 			this.ctx.showError("/tan requires a persisted session.");
-			return false;
+			return undefined;
 		}
@@ -332,5 +332,5 @@
 		} catch (error) {
 			if (cloneFile) await removeCloneSession(cloneFile);
 			this.ctx.showError(error instanceof Error ? error.message : String(error));
-			return false;
+			return undefined;
 		}
