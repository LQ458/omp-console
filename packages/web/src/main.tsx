import { createRoot } from "react-dom/client";
import { App } from "./app";
import { isBenchRequested } from "./lib/bench";
import { applyStoredTheme, registerServiceWorker } from "./lib/boot";
import { consumePairFragment } from "./lib/deeplink";
import "./styles/tokens.css";
import "./styles/base.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
const initialPairCode = consumePairFragment(window);
applyStoredTheme();
registerServiceWorker();

const renderApp = (): void => createRoot(root).render(<App initialPairCode={initialPairCode ?? undefined} />);

if (isBenchRequested(window.location.search)) {
	void import("./lib/bench-bridge").then(({ installBench }) => {
		installBench();
		renderApp();
	}).catch(error => {
		console.error("omp console benchmark instrumentation failed to load", error);
		renderApp();
	});
} else {
	renderApp();
}
