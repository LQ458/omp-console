/** Headless omp console operations backed by omp's GitModel and the session's repository. */
import type {
	GitAssetPreview,
	GitChangedFile,
	GitCommitSummary,
	GitDiffLine,
	GitFileDiff,
	GitImagePreview,
	GitStatusSnapshot,
} from "@omp-console/protocol";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { buildDiffDocument } from "@oh-my-pi/pi-tui/apps/git/diff-pane";
import type { ChangedFile, FileAssetSide, FileContents, HeadCommit } from "@oh-my-pi/pi-tui/apps/git/state";
import { GitModel } from "@oh-my-pi/pi-coding-agent/cli/git-tui/state";
import { RequestError } from "./request-error";

function fileSummary(file: ChangedFile): GitChangedFile {
	return {
		path: file.path,
		kind: file.kind,
		area: file.area,
		...(file.origPath === undefined ? {} : { origPath: file.origPath }),
		...(file.additions === undefined ? {} : { additions: file.additions }),
		...(file.deletions === undefined ? {} : { deletions: file.deletions }),
	};
}

function commitSummary(commit: HeadCommit | null): GitCommitSummary | null {
	if (!commit) return null;
	return {
		sha: commit.sha,
		shortSha: commit.shortSha,
		subject: commit.subject,
		body: commit.body,
		authorName: commit.authorName,
		authorDate: commit.authorDate,
		parents: [...commit.parents],
	};
}

function imagePreview(image: Extract<FileAssetSide, { kind: "image" }>["image"]): GitImagePreview {
	return {
		data: image.data,
		mimeType: image.mimeType,
		sourceMimeType: image.sourceMimeType,
		widthPx: image.widthPx,
		heightPx: image.heightPx,
		byteLength: image.byteLength,
	};
}

function assetPreview(side: FileAssetSide): GitAssetPreview {
	switch (side.kind) {
		case "empty":
			return { kind: side.kind };
		case "image":
			return { kind: side.kind, image: imagePreview(side.image) };
		case "lfsMissing":
			return { kind: side.kind, oid: side.oid, byteLength: side.byteLength };
		case "text":
		case "binary":
		case "tooLarge":
			return {
				kind: side.kind,
				...(side.byteLength === undefined ? {} : { byteLength: side.byteLength }),
				...(side.lfsOid === undefined ? {} : { oid: side.lfsOid }),
			};
	}
}

function fileDiff(contents: FileContents, filePath: string): GitFileDiff {
	if (contents.kind === "asset") return { kind: "asset", old: assetPreview(contents.old), new: assetPreview(contents.new) };
	const document = buildDiffDocument(contents.oldText, contents.newText, filePath, { streamResult: contents.streamResult });
	const hunks = document.hunks.map(hunk => {
		const lines: GitDiffLine[] = [];
		for (const row of hunk.rows) {
			switch (row.kind) {
				case "context":
					lines.push({ kind: "context", text: row.newText });
					break;
				case "add":
					lines.push({ kind: "add", text: row.newText });
					break;
				case "del":
					lines.push({ kind: "del", text: row.oldText });
					break;
				case "change":
					lines.push({ kind: "del", text: row.oldText }, { kind: "add", text: row.newText });
					break;
			}
		}
		return {
			header: hunk.header,
			patchHash: new Bun.CryptoHasher("sha256").update(hunk.patch).digest("hex"),
			lines,
		};
	});
	return { kind: "text", hunks, canPatch: document.canPatch };
}

export class GitService {
	readonly #cwd: string;

	constructor(cwd: string) {
		this.#cwd = cwd;
	}

	async view(revision?: string): Promise<GitStatusSnapshot> {
		return this.#snapshot(await this.#model(revision));
	}

	async diff(path: string, area: ChangedFile["area"], revision?: string): Promise<GitFileDiff> {
		const model = await this.#model(revision);
		if (model.pinnedSha !== null && area !== "commit") {
			throw new RequestError("bad-request", "revision views only contain committed files");
		}
		const files =
			area === "commit"
				? (model.headCommit?.files ?? [])
				: area === "staged"
					? model.staged
					: model.unstaged;
		const file = files.find(candidate => candidate.path === path);
		if (!file) throw new RequestError("not-found", `no ${area} change for ${path}`);
		const contents = await model.streamContents(file, () => {});
		return fileDiff(contents, path);
	}
	async applyHunk(
		action: "stage" | "unstage",
		filePath: string,
		area: "unstaged" | "staged",
		hunkIndex: number,
		expectedPatchHash: string,
	): Promise<GitStatusSnapshot> {
		if (!Number.isInteger(hunkIndex) || hunkIndex < 0) throw new RequestError("bad-request", "hunk index must be a non-negative integer");
		if ((action === "stage" && area !== "unstaged") || (action === "unstage" && area !== "staged")) {
			throw new RequestError("bad-request", "stage targets unstaged hunks and unstage targets staged hunks");
		}
		const model = await this.#model();
		const file = (area === "unstaged" ? model.unstaged : model.staged).find(candidate => candidate.path === filePath);
		if (!file) throw new RequestError("not-found", `no ${area} change for ${filePath}`);
		const contents = await model.streamContents(file, () => {});
		if (contents.kind !== "text") throw new RequestError("bad-request", "hunk operations require a text diff");
		const document = buildDiffDocument(contents.oldText, contents.newText, file.path, { streamResult: contents.streamResult });
		const hunk = document.hunks[hunkIndex];
		if (!document.canPatch || !hunk || hunk.patch === "") throw new RequestError("not-found", `no applyable hunk ${hunkIndex + 1} for ${filePath}`);
		if (new Bun.CryptoHasher("sha256").update(hunk.patch).digest("hex") !== expectedPatchHash) {
			throw new RequestError("conflict", "the file changed; reload its diff before applying a hunk");
		}
		await model.applyPatch(hunk.patch, { cached: true, reverse: action === "unstage" });
		await model.refresh();
		await model.loadChangeStats();
		return this.#snapshot(model);
	}

	async stage(action: "stage" | "unstage", paths: string[]): Promise<GitStatusSnapshot> {
		const model = await this.#model();
		if (paths.length === 0) throw new RequestError("bad-request", "select at least one changed file");
		const candidates = action === "stage" ? model.unstaged : model.staged;
		const byPath = new Map(candidates.map(file => [file.path, file] as const));
		const uniquePaths = [...new Set(paths)];
		const selected: ChangedFile[] = [];
		for (const path of uniquePaths) {
			const file = byPath.get(path);
			if (!file) throw new RequestError("not-found", `no ${action === "stage" ? "unstaged" : "staged"} change for ${path}`);
			selected.push(file);
		}
		if (action === "stage") await model.stage(selected);
		else await model.unstage(selected);
		await model.refresh();
		await model.loadChangeStats();
		return this.#snapshot(model);
	}

	async commit(message: string): Promise<GitStatusSnapshot> {
		const model = await this.#model();
		if (model.pinnedSha !== null) throw new RequestError("conflict", "revision views are read-only");
		if (model.staged.length === 0) throw new RequestError("conflict", "stage at least one file before committing");
		await model.commit(message);
		return this.view();
	}

	async #model(revision?: string): Promise<GitModel> {
		const repo = vcs.git(this.#cwd);
		const root = repo?.info().repoRoot;
		if (!repo || !root) throw new RequestError("bad-request", `not a git repository: ${this.#cwd}`);
		let pinnedSha: string | undefined;
		if (revision !== undefined) {
			pinnedSha = (await repo.resolveRef(revision)) ?? undefined;
			if (!pinnedSha) throw new RequestError("bad-request", `cannot resolve revision: ${revision}`);
		}
		const model = new GitModel(root, pinnedSha === undefined ? {} : { pinnedSha });
		await model.refresh();
		if (model.pinnedSha !== null) {
			if (!model.headCommit) throw new RequestError("not-found", `cannot read revision: ${revision}`);
			await model.loadHeadFiles();
		} else {
			await model.loadChangeStats();
			if (model.clean) await model.loadHeadFiles();
		}
		return model;
	}

	#snapshot(model: GitModel): GitStatusSnapshot {
		return {
			branch: model.branch,
			clean: model.clean,
			readOnly: model.pinnedSha !== null,
			...(model.pinnedSha === null ? {} : { revision: model.pinnedSha }),
			unstaged: model.unstaged.map(fileSummary),
			staged: model.staged.map(fileSummary),
			commitFiles: (model.headCommit?.files ?? []).map(fileSummary),
			headCommit: commitSummary(model.headCommit),
		};
	}
}
