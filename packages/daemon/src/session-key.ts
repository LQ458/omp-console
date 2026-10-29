import { realpathSync } from "node:fs";
import * as path from "node:path";

/**
 * A comparison key for session files and folders; display paths stay in their original spelling.
 *
 * On Windows the key must not depend on whether the file exists yet: a file recorded before it was written and the
 * same file looked up afterwards must compare equal, so the deepest existing ancestor is resolved natively (expanding
 * 8.3 names such as `RUNNER~1` and junctions) and the missing tail is appended before lower-casing.
 */
export function sessionPathKey(target: string): string {
	if (process.platform !== "win32") return target;
	const resolved = path.resolve(target);
	const tail: string[] = [];
	let current = resolved;
	for (;;) {
		try {
			return path.join(realpathSync.native(current), ...tail).toLowerCase();
		} catch {
			const parent = path.dirname(current);
			if (parent === current) return resolved.toLowerCase();
			tail.unshift(path.basename(current));
			current = parent;
		}
	}
}
