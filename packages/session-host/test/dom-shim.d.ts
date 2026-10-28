// Tests import the vendored collab-web `GuestClient` (test/collab-web/client.ts), which calls the browser's
// animation-frame functions. They are never invoked under Bun here; declare only what the type checker needs.
declare function requestAnimationFrame(callback: (timestamp: number) => void): number;
declare function cancelAnimationFrame(handle: number): void;
