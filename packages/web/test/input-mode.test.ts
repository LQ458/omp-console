import { describe, expect, it } from "bun:test";
import { detectShellMode, findGitHubReference, githubReferenceUri, parseBtwCommand, parseShellInput } from "../src/components/composer/input-mode";

describe("omp composer input modes", () => {
	it("distinguishes bash and Python prefixes and honors doubled context exclusion", () => {
		expect(parseShellInput("! echo hello")).toEqual({ kind: "bash", code: "echo hello", excludeFromContext: false });
		expect(parseShellInput("!!rm -f scratch")).toEqual({ kind: "bash", code: "rm -f scratch", excludeFromContext: true });
		expect(parseShellInput("$ print('hello')")).toEqual({ kind: "python", code: "print('hello')", excludeFromContext: false });
		expect(parseShellInput("$$ print('private')")).toEqual({ kind: "python", code: "print('private')", excludeFromContext: true });
	});

	it("keeps shell variables and incomplete prefixes as ordinary input", () => {
		expect(detectShellMode("$HOME is set")).toBeNull();
		expect(parseShellInput("$ ")).toBeNull();
		expect(parseShellInput("! ")).toBeNull();
		expect(detectShellMode("$$ ")).toMatchObject({ kind: "python", code: "", excludeFromContext: true });
	});

	it("offers issue and pull-request internal URLs only for a complete positive number before the caret", () => {
		expect(findGitHubReference("Fix #123", 8)).toEqual({ number: 123, start: 4, end: 8 });
		expect(githubReferenceUri("issue", 123)).toBe("issue://123");
		expect(githubReferenceUri("pr", 123)).toBe("pr://123");
		expect(findGitHubReference("#0", 2)).toBeNull();
		expect(findGitHubReference("#123abc", 7)).toBeNull();
		expect(findGitHubReference("#123 ", 5)).toBeNull();
		expect(findGitHubReference("#123abc", 4)).toBeNull();
		expect(findGitHubReference("#123é", 4)).toBeNull();
	});

	it("extracts a /btw question without consuming unrelated slash commands", () => {
		expect(parseBtwCommand("/btw Why is this needed?")).toEqual({ question: "Why is this needed?" });
		expect(parseBtwCommand("/btw")).toEqual({ question: "" });
		expect(parseBtwCommand("/btwist something")).toBeNull();
	});
});
