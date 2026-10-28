import type { PendingUiRequest } from "@omp-console/protocol";
import { describe, expect, it } from "bun:test";
import { SkillsPanel, findSkillScriptApproval, parseSkillCommand } from "../src/components/skills/SkillsPanel";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DeckApi } from "../src/lib/api";

describe("/skills command parsing", () => {
	it("routes multiword searches and package installs to their panel actions", () => {
		expect(parseSkillCommand(" search TypeScript testing ")).toEqual({ kind: "search", query: "TypeScript testing" });
		expect(parseSkillCommand("install @scope/one@^2 @scope/two -g")).toEqual({
			kind: "install",
			specs: ["@scope/one@^2", "@scope/two"],
			global: true,
		});
	});

	it("treats an unqualified update as all installed skills", () => {
		expect(parseSkillCommand("update --global")).toEqual({ kind: "update", names: [], global: true });
	});

	it("rejects missing install packages and unsupported options", () => {
		expect(parseSkillCommand("install").kind).toBe("invalid");
		expect(parseSkillCommand("search test --global")).toEqual({ kind: "search", query: "test --global" });
		expect(parseSkillCommand("update --force")).toMatchObject({ kind: "invalid" });
	});
});
describe("skill script approval correlation", () => {
	it("returns only the approval raised by this operation and strips its internal marker", () => {
		const request = (reqId: string, title: string): PendingUiRequest => ({
			reqId,
			kind: "select",
			title,
			options: [{ label: "Yes" }, { label: "No" }],
			at: 1,
		});
		const requests = [
			request("older", "Install skill with scripts?\n@omp-console/old scripts:"),
			request("other-op", "Install skill with scripts?\n@omp-console/other scripts:\n\n[omp-console-skill-approval:other-op]"),
			request("current", "Install skill with scripts?\n@omp-console/current scripts:\n\n[omp-console-skill-approval:current-op]"),
		];

		const approval = findSkillScriptApproval(requests, "current-op");
		expect(approval).toMatchObject({ reqId: "current", title: "Install skill with scripts?\n@omp-console/current scripts:" });
		expect(findSkillScriptApproval(requests, "missing")).toBeNull();
	});
});

describe("read-only Skills panel", () => {
	it("disables direct package installation controls", () => {
		const api: Pick<DeckApi, "sessionOpV3"> = { sessionOpV3: async () => ({ ok: true }) };
		const html = renderToStaticMarkup(createElement(SkillsPanel, {
			api,
			sessionId: "session",
			readOnly: true,
			command: "skills",
			args: "",
			onClose: () => {},
		}));
		let installInputDisabled = false;
		let installButtonDisabled = false;
		let globalScopeDisabled = false;
		new HTMLRewriter()
			.on("#sk-install-spec", { element: element => { installInputDisabled = element.hasAttribute("disabled"); } })
			.on(".sk-install button", { element: element => { installButtonDisabled = element.hasAttribute("disabled"); } })
			.on(".sk-global input", { element: element => { globalScopeDisabled = element.hasAttribute("disabled"); } })
			.transform(html);
		expect([installInputDisabled, installButtonDisabled, globalScopeDisabled]).toEqual([true, true, true]);
	});
});
