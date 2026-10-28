import * as fs from "node:fs/promises";
import * as path from "node:path";

function isMissing(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
export class UnsafeWorkspacePathError extends Error {
	readonly code = "bad-request";

	constructor(message: string) {
		super(message);
	}
}

export async function assertNoSymlinkComponents(root: string, relative: string): Promise<void> {
	const absoluteRoot = path.resolve(root);
	let current = absoluteRoot;
	try {
		if ((await fs.lstat(current)).isSymbolicLink()) throw new UnsafeWorkspacePathError("symlink workspace root is not allowed");
	} catch (error) {
		if (!isMissing(error)) throw error;
		return;
	}
	for (const part of relative.split("/").filter(Boolean)) {
		current = path.join(current, part);
		try {
			if ((await fs.lstat(current)).isSymbolicLink()) throw new UnsafeWorkspacePathError("symlink components are not allowed");
		} catch (error) {
			if (!isMissing(error)) throw error;
			return;
		}
	}
}

export async function atomicWriteFile(filePath: string, content: string, mode: number): Promise<void> {
	const directory = path.dirname(filePath);
	await fs.mkdir(directory, { recursive: true });
	const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
	const handle = await fs.open(temporaryPath, "wx", mode);
	try {
		await handle.writeFile(content, "utf8");
		await handle.sync();
	} catch (error) {
		await handle.close();
		await fs.rm(temporaryPath, { force: true });
		throw error;
	}
	await handle.close();
	try {
		await fs.rename(temporaryPath, filePath);
	} catch (error) {
		await fs.rm(temporaryPath, { force: true });
		throw error;
	}
}
