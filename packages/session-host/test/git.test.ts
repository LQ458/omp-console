import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { VcsGitRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { GitService } from "../src/git";

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { force: true, recursive: true })));
});

async function temporaryRepository(): Promise<{ root: string; repository: VcsGitRepo }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "deck-git-service-"));
	temporaryRoots.push(root);
	const clonePath = path.join(root, "repo");
	const source = vcs.git(import.meta.dir);
	if (!source) throw new Error("the test workspace must be a Git checkout");
	await vcs.clone(source.info().repoRoot, clonePath);
	const repository = vcs.requireGit(clonePath);
	await repository.configSet("user.name", "omp console test");
	await repository.configSet("user.email", "omp-console-test@example.invalid");
	await repository.configSet("commit.gpgsign", "false");
	await repository.configSet("core.hooksPath", path.join(root, "empty-hooks"));
	await repository.configSet("core.autocrlf", "false");
	return { root: clonePath, repository };
}

test("Git service scopes file operations, stages one hunk at a time, commits locally, and opens read-only revisions", async () => {
	const { root, repository } = await temporaryRepository();
	const filePath = "deck-git-fixture.txt";
	const absolutePath = path.join(root, filePath);
	const original = `${Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n")}\n`;
	const edited = original.replace("line 2\n", "changed two\n").replace("line 28\n", "changed twenty-eight\n");
	await Bun.write(absolutePath, original);
	await repository.stageFiles([filePath]);
	await repository.commitCreate("fixture baseline", {});
	const baseline = await repository.headSha();
	if (!baseline) throw new Error("fixture baseline commit was not created");

	await Bun.write(absolutePath, edited);
	const service = new GitService(root);
	const working = await service.view();
	expect(working.unstaged.some(file => file.path === filePath && file.kind === "modified")).toBe(true);

	const diff = await service.diff(filePath, "unstaged");
	if (diff.kind !== "text") throw new Error("fixture text should produce a line diff");
	expect(diff.canPatch).toBe(true);
	expect(diff.hunks).toHaveLength(2);
	const firstHunk = diff.hunks?.[0];
	const secondHunk = diff.hunks?.[1];
	if (!firstHunk || !secondHunk) throw new Error("fixture changes should form separate hunks");
	expect(firstHunk.lines).toContainEqual({ kind: "del", text: "line 2" });
	expect(firstHunk.lines).toContainEqual({ kind: "add", text: "changed two" });
	expect(secondHunk.lines).toContainEqual({ kind: "del", text: "line 28" });
	expect(secondHunk.lines).toContainEqual({ kind: "add", text: "changed twenty-eight" });
	await expect(service.stage("stage", ["../outside.txt"])).rejects.toThrow("no unstaged change");
	expect((await service.view()).unstaged.some(file => file.path === filePath)).toBe(true);

	const firstStage = await service.applyHunk("stage", filePath, "unstaged", 0, firstHunk.patchHash);
	expect(firstStage.staged.some(file => file.path === filePath)).toBe(true);
	expect(firstStage.unstaged.some(file => file.path === filePath)).toBe(true);
	const stagedDiff = await service.diff(filePath, "staged");
	if (stagedDiff.kind !== "text") throw new Error("staged fixture should produce a line diff");
	expect(stagedDiff.hunks).toHaveLength(1);
	expect(stagedDiff.hunks[0]?.lines).toContainEqual({ kind: "add", text: "changed two" });
	const remainingDiff = await service.diff(filePath, "unstaged");
	if (remainingDiff.kind !== "text") throw new Error("unstaged fixture should retain a line diff");
	expect(remainingDiff.hunks.flatMap(hunk => hunk.lines)).toContainEqual({ kind: "add", text: "changed twenty-eight" });

	await Bun.write(absolutePath, edited.replace("changed two\n", "changed two again\n"));
	await expect(service.applyHunk("stage", filePath, "unstaged", 0, secondHunk.patchHash)).rejects.toThrow("file changed");
	await Bun.write(absolutePath, edited);

	const firstUnstage = stagedDiff.hunks?.[0];
	if (!firstUnstage) throw new Error("staged change should expose an unstageable hunk");
	const unstaged = await service.applyHunk("unstage", filePath, "staged", 0, firstUnstage.patchHash);
	expect(unstaged.staged).toHaveLength(0);
	expect(unstaged.unstaged.some(file => file.path === filePath)).toBe(true);

	const revision = await service.view(baseline);
	expect(revision.readOnly).toBe(true);
	expect(revision.revision).toBe(baseline);
	expect(revision.commitFiles.some(file => file.path === filePath)).toBe(true);
	const revisionDiff = await service.diff(filePath, "commit", baseline);
	if (revisionDiff.kind !== "text") throw new Error("revision fixture should produce a line diff");
	expect(revisionDiff.hunks.flatMap(hunk => hunk.lines)).toContainEqual({ kind: "add", text: "line 1" });

	const staged = await service.stage("stage", [filePath]);
	expect(staged.staged.some(file => file.path === filePath)).toBe(true);
	await expect(service.stage("unstage", ["missing.txt"])).rejects.toThrow("no staged change");
	const committed = await service.commit("Deck local commit");
	expect(committed.staged).toHaveLength(0);
	expect(committed.unstaged).toHaveLength(0);
	expect(committed.clean).toBe(true);
	expect(committed.headCommit?.subject).toBe("Deck local commit");
	expect(committed.commitFiles.some(file => file.path === filePath)).toBe(true);
}, 30_000);
