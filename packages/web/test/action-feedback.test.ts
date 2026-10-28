import { describe, expect, it } from "bun:test";
import { ActionFeedbackController } from "../src/lib/action-feedback";

describe("async action feedback", () => {
	it("holds pending through the operation and clears success after 700 ms", async () => {
		const scheduled: { timer?: () => void; delay: number } = { delay: 0 };
		const controller = new ActionFeedbackController((callback, delayMs) => {
			scheduled.timer = callback;
			scheduled.delay = delayMs;
			return () => { scheduled.timer = undefined; };
		});
		const deferred = Promise.withResolvers<string>();
		const running = controller.run(() => deferred.promise);

		expect(controller.getSnapshot()).toEqual({ state: "pending", error: null });
		deferred.resolve("opened");
		expect(await running).toBe("opened");
		expect(controller.getSnapshot()).toEqual({ state: "success", error: null });
		expect(scheduled.delay).toBe(700);
		scheduled.timer?.();
		expect(controller.getSnapshot()).toEqual({ state: "idle", error: null });
		controller.dispose();
	});

	it("rejects a second in-flight action and keeps a surfaced failure until retry", async () => {
		const controller = new ActionFeedbackController(() => () => {});
		const deferred = Promise.withResolvers<void>();
		const running = controller.run(() => deferred.promise);
		const rejection = running.then(() => null, error => error);
		let duplicateRan = false;

		expect(await controller.run(() => { duplicateRan = true; })).toBeUndefined();
		expect(duplicateRan).toBe(false);
		deferred.reject(new Error("Archive failed"));
		const cause: unknown = await rejection;
		expect(cause).toBeInstanceOf(Error);
		if (!(cause instanceof Error)) throw new Error("expected the action failure to be an Error");
		expect(cause.message).toBe("Archive failed");
		expect(controller.getSnapshot()).toEqual({ state: "failure", error: "Archive failed" });
		expect(controller.begin()).toBe(true);
		expect(controller.getSnapshot()).toEqual({ state: "pending", error: null });
		controller.reset();
		controller.dispose();
	});
});
