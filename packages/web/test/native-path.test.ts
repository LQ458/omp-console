import { describe, expect, it } from "bun:test";
import { abbreviateHome, basename, fileUrlToPath, isAbsolutePath, isInside, pathKey } from "../src/lib/native-path";
import { shortenPath } from "../src/lib/format";
import { shortenPath as shortenToolPath } from "../src/tool-render/util";
import { colorSeed, type ColorSubject } from "../src/lib/workspace-color";

const project: ColorSubject = {
	id: "project:workspace",
	kind: "project",
	name: "Workspace",
	root: "C:\\Users\\Alex\\work\\repo",
};

describe("native paths", () => {
	it("recognizes POSIX, drive-letter and UNC absolute paths, but not drive-relative paths", () => {
		expect(isAbsolutePath("/Users/you/project")).toBe(true);
		expect(isAbsolutePath("C:\\Users\\Alex\\project")).toBe(true);
		expect(isAbsolutePath("c:/Users/you/project")).toBe(true);
		expect(isAbsolutePath("\\\\server\\share\\project")).toBe(true);
		expect(isAbsolutePath("C:project")).toBe(false);
		expect(isAbsolutePath("project\\src")).toBe(false);
	});

	it("normalizes Windows comparison keys without changing POSIX spelling or case", () => {
		expect(pathKey("C:\\Users\\Alex\\Repo")).toBe("c:/users/alex/repo");
		expect(pathKey("c:/users/alex/repo")).toBe("c:/users/alex/repo");
		expect(pathKey("\\\\Server\\Share\\Repo")).toBe("//server/share/repo");
		expect(pathKey("/Users/you/Repo")).toBe("/Users/you/Repo");
		expect(pathKey("/Users/you/Repo")).not.toBe(pathKey("/users/you/repo"));
	});

	it("checks containment at a path boundary for Windows and POSIX roots", () => {
		expect(isInside("C:\\work\\Repo\\", "c:/WORK/repo/src")).toBe(true);
		expect(isInside("C:\\work\\repo", "C:/work/repository")).toBe(false);
		expect(isInside("\\\\server\\share", "//SERVER/share/project")).toBe(true);
		expect(isInside("/work/Repo", "/work/Repo/src")).toBe(true);
		expect(isInside("/work/Repo", "/work/repo/src")).toBe(false);
		expect(isInside("/work/a", "/work/ab")).toBe(false);
	});

	it("extracts native basenames and abbreviates home paths without changing POSIX display", () => {
		expect(basename("C:\\Users\\Alex\\repo\\")).toBe("repo");
		expect(basename("/Users/you/repo/")).toBe("repo");
		expect(basename("/Users/you/repo\\name")).toBe("repo\\name");
		expect(pathKey("/Users/you/repo\\src")).toBe("/Users/you/repo\\src");
		expect(basename("C:\\")).toBe("");
		expect(abbreviateHome("C:\\Users\\Alex\\work\\repo")).toBe("~\\work\\repo");
		expect(abbreviateHome("/Users/you/work/repo")).toBe("~/work/repo");
		expect(shortenPath("C:\\Users\\Alex\\work\\omp-console\\packages\\web\\src")).toBe("~\\…\\web\\src");
		expect(shortenPath("/Users/you/work/omp-console/packages/web/src")).toBe("~/…/web/src");
		expect(shortenPath("/Users/you/work/omp-console/packages/web/a\\b.ts")).toBe("~/…/web/a\\b.ts");
		expect(shortenToolPath("C:\\Users\\Alex\\work\\repo")).toBe("~\\work\\repo");
		expect(shortenToolPath("/Users/you/work/repo")).toBe("~/work/repo");
		expect(colorSeed(project)).toBe("repo");
	});

	it("converts local, drive-letter and UNC file URLs, decoding escaped characters", () => {
		expect(fileUrlToPath("file:///Users/you/Downloads/a%20b.txt")).toBe("/Users/you/Downloads/a b.txt");
		expect(fileUrlToPath("file:///C:/Users/you/Downloads/a%20b.txt")).toBe("C:\\Users\\you\\Downloads\\a b.txt");
		expect(fileUrlToPath("file://server/share/dir/a%20b.txt")).toBe("\\\\server\\share\\dir\\a b.txt");
		expect(fileUrlToPath("https://example.com/file.txt")).toBeNull();
		expect(fileUrlToPath("file:///bad/%ZZ")).toBeNull();
	});
});
