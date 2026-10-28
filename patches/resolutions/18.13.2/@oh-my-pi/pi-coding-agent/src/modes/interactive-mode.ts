# omp-sync-resolution v1
theirs
--- patch ---
diff --git a/src/modes/interactive-mode.ts b/src/modes/interactive-mode.ts
--- a/src/modes/interactive-mode.ts
+++ b/src/modes/interactive-mode.ts
@@ -9059,3 +9059,3 @@
-	handleTanCommand(work: string, images?: ImageContent[]): Promise<boolean> {
-		return this.#tanCommandController.start(work, images);
+	async handleTanCommand(work: string, images?: ImageContent[]): Promise<boolean> {
+		return (await this.#tanCommandController.start(work, images)) !== undefined;
 	}
