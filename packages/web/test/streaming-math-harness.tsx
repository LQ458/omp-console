import { StrictMode, useState } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { LazyRegion } from "../src/components/shell/LazyRegion";
import { lazyWithRecovery } from "../src/lib/lazy";
import { StreamingMarkdown } from "../src/components/transcript/Markdown";
import "../src/styles/tokens.css";
import "../src/styles/base.css";
import "../src/components/transcript/transcript.css";

function StreamingMathHarness(): ReactNode {
	const [stage, setStage] = useState(1);
	const figure = ["```svg", '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>', "```"].join("\n");
	const text =
		stage === 1
			? [`Euler: $e^{i\\pi}+1=0$`, "", figure].join("\n")
			: [
					`Euler: $e^{i\\pi}+1=0$`,
					"",
					figure,
					"",
					"$$\\int_0^1 x\\,dx$$",
					"",
					"| name | role |",
					"| --- | --- |",
					"| Ada | lead |",
					"| Lin | review |",
				].join("\n");
	return (
		<main data-stream-stage={stage}>
			<StreamingMarkdown text={text} />
			{stage === 1 && <button type="button" onClick={() => setStage(2)}>Continue stream</button>}
		</main>
	);
}
const MissingChunk = lazyWithRecovery(async () => {
	throw new Error("missing lazy chunk");
});

const root = document.getElementById("root");
if (root === null) throw new Error("streaming math harness root is missing");
if (new URLSearchParams(window.location.search).has("fallback")) {
	const staleBuild = new URLSearchParams(window.location.search).has("stale");
	window.sessionStorage.setItem("omp-console:lazy-chunk-reload", staleBuild ? "newbuild999" : "development");
	createRoot(root).render(
		<LazyRegion fallback={<div role="status">Loading failed chunk…</div>}>
			<MissingChunk />
		</LazyRegion>,
	);
} else {
	createRoot(root).render(
		<StrictMode>
			<StreamingMathHarness />
		</StrictMode>,
	);
}
