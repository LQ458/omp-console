/**
 * Runs the `?bench` scenarios in headless Chromium through `omp-sweep` (Playwright in its own
 * process; no interactive browser tab) and prints one JSON document.
 *
 *   bun run build                                   # once: static assets in dist/
 *   bun bench/run-headless.ts                       # both scenarios against the built-in mock daemon
 *   bun bench/run-headless.ts --scenario scroll --scroll-ms 12000 --scroll-px 120000
 *   bun bench/run-headless.ts --width 390 --height 844        # phone-sized viewport
 *
 * THE NUMBERS ARE NOT THE RUBRIC'S. Headless Chromium has no WKWebView/iPhone Safari compositor, no
 * ProMotion display and no phone CPU; they show regressions and relative cost only. For the rubric
 * numbers load the same page on the device and run the same probe there:
 *
 *   bun bench/run-headless.ts --serve               # mock daemon + fixtures on 0.0.0.0, prints the URLs
 *   bun bench/run-headless.ts --print-probe scroll  # JS to paste into the device's web inspector
 *   bun bench/run-headless.ts --url https://host/?bench#session=bench-50k   # headless against any daemon
 *
 * Scenarios: `scroll` loads the 50k-line fixture, scrolls down and back up at constant speed;
 * `stream` joins the 100 tokens/s room and records token-to-paint while the tail follows.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $which } from "@oh-my-pi/pi-utils";
import { BENCH_STREAM_SESSION_ID, BENCH_TRANSCRIPT_SESSION_ID, startMockDaemon } from "../dev/mock-daemon";
import { PANE_SESSION_IDS } from "../dev/mock-panes";
import { countLines, DEFAULT_TRANSCRIPT_LINES, makeTranscript } from "./make-transcript";

type Scenario = "scroll" | "stream" | "panes";

interface Options {
	dist: string;
	url: string | undefined;
	scenarios: Scenario[];
	width: number;
	height: number;
	scrollMs: number;
	scrollPx: number;
	streamMs: number;
	chrome: string | undefined;
	out: string | undefined;
	serve: boolean;
	printProbe: Scenario | undefined;
	port: number;
}

const DEFAULTS = {
	width: 1280,
	height: 800,
	scrollMs: 12_000,
	/** 10,000 px/s: a fast fling, so the run is stricter than ordinary reading. */
	scrollPx: 120_000,
	streamMs: 10_000,
};

function arg(argv: readonly string[], name: string): string | undefined {
	for (let i = 0; i < argv.length; i++) {
		const current = argv[i]!;
		if (current === name) return argv[i + 1];
		if (current.startsWith(`${name}=`)) return current.slice(name.length + 1);
	}
	return undefined;
}

function num(argv: readonly string[], name: string, fallback: number): number {
	const raw = arg(argv, name);
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number, got ${raw}`);
	return value;
}

function parseOptions(argv: readonly string[]): Options {
	const scenario = arg(argv, "--scenario") ?? "all";
	if (scenario !== "all" && scenario !== "scroll" && scenario !== "stream" && scenario !== "panes") {
		throw new Error(`--scenario must be scroll, stream, panes or all, got ${scenario}`);
	}
	const printProbe = arg(argv, "--print-probe");
	if (printProbe !== undefined && printProbe !== "scroll" && printProbe !== "stream" && printProbe !== "panes") {
		throw new Error(`--print-probe must be scroll, stream or panes, got ${printProbe}`);
	}
	return {
		dist: path.resolve(arg(argv, "--dist") ?? path.join(import.meta.dir, "..", "dist")),
		url: arg(argv, "--url"),
		scenarios: scenario === "all" ? ["scroll", "stream", "panes"] : [scenario],
		width: num(argv, "--width", DEFAULTS.width),
		height: num(argv, "--height", DEFAULTS.height),
		scrollMs: num(argv, "--scroll-ms", DEFAULTS.scrollMs),
		scrollPx: num(argv, "--scroll-px", DEFAULTS.scrollPx),
		streamMs: num(argv, "--stream-ms", DEFAULTS.streamMs),
		chrome: arg(argv, "--chrome"),
		out: arg(argv, "--out"),
		serve: argv.includes("--serve"),
		printProbe,
		port: Number(arg(argv, "--port") ?? 0),
	};
}

/**
 * Six live sessions streaming 100 tokens/s, one per pane, opened the way a user does (Cmd+D / Cmd+Shift+D and the
 * `#session=` deep link), then `?bench` frames for `streamMs`. The last pane opened has focus, so `droppedPct` is
 * the dropped-frame share of the page while the focused pane renders at full rate and five background panes batch
 * at 4 Hz. Page-level because a dropped `requestAnimationFrame` interval is a frame the focused pane missed.
 */
function panesProbe(streamMs: number): string {
	return `
const bench = window.__deckBench;
if (!bench) return [JSON.stringify({ error: "window.__deckBench is missing: open the page with ?bench" })];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ids = ${JSON.stringify(PANE_SESSION_IDS)};
const key = async (k, mods = {}) => {
	window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, metaKey: true, ...mods }));
	await sleep(500);
};
const open = async id => {
	location.hash = "#session=" + id;
	await sleep(1200);
};
const deadline = performance.now() + 60000;
while (!document.querySelector(".pn-frame .sh-composer") && performance.now() < deadline) await sleep(100);
await open(ids[0]);
await key("d");
await open(ids[1]);
await key("d");
await open(ids[2]);
await key("ArrowLeft", { altKey: true });
await key("ArrowLeft", { altKey: true });
await key("D", { shiftKey: true });
await open(ids[3]);
await key("ArrowRight", { altKey: true });
await key("D", { shiftKey: true });
await open(ids[4]);
await key("ArrowRight", { altKey: true });
await key("D", { shiftKey: true });
await open(ids[5]);
const panes = [...document.querySelectorAll(".pn-frame")];
while (panes.some(el => !el.querySelector(".tr-vrow")) && performance.now() < deadline) await sleep(100);
await sleep(2000);
const rowsPerPane = [...document.querySelectorAll(".pn-frame")].map(el => el.querySelectorAll(".tr-vrow").length);
bench.start();
await sleep(${streamMs});
const result = bench.stop();
const focused = document.querySelector('.pn-frame[data-focused="true"]');
return [JSON.stringify({
	panes: document.querySelectorAll(".pn-frame").length,
	focusedPane: focused ? focused.dataset.pane : null,
	streamingPanes: [...document.querySelectorAll(".pn-frame")].filter(el => el.querySelector('button[aria-label="stop the current turn"]')).length,
	result,
	mountedRowsPerPane: rowsPerPane,
	jsHeapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
})];
`;
}

/**
 * The page-side script: one async expression that waits for the transcript, runs the scenario
 * through `window.__deckBench` and returns `[JSON]` (omp-sweep reports non-empty probe results).
 */
export function probeFor(scenario: Scenario, options: Pick<Options, "scrollMs" | "scrollPx" | "streamMs">): string {
	if (scenario === "panes") return `(async () => {${panesProbe(options.streamMs)}})()`;
	const common = `
const bench = window.__deckBench;
if (!bench) return [JSON.stringify({ error: "window.__deckBench is missing: open the page with ?bench" })];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = performance.now() + 90000;
while (!document.querySelector("[data-deck-scroller] .tr-vrow") && performance.now() < deadline) await sleep(100);
const scroller = document.querySelector("[data-deck-scroller]");
if (!scroller) return [JSON.stringify({ error: "transcript never rendered" })];
const readyMs = Math.round(performance.now());
await sleep(1500);
const list = scroller.querySelector(".tr-list");
const dom = () => ({
	mountedRows: scroller.querySelectorAll(".tr-vrow").length,
	renderedEntries: Number(scroller.querySelector(".tr-vrow")?.getAttribute("aria-setsize") ?? 0),
	scrollHeight: Math.round(scroller.scrollHeight),
	jsHeapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
});
`;
	const scroll = `
scroller.scrollTop = 0;
await sleep(800);
bench.start();
const down = await bench.scroll({ durationMs: ${options.scrollMs}, direction: "down", distancePx: ${options.scrollPx} });
const up = await bench.scroll({ durationMs: ${options.scrollMs}, direction: "up", distancePx: ${options.scrollPx} });
const result = bench.stop();
return [JSON.stringify({ transcriptReadyMs: readyMs, result, scroll: { down, up }, dom: dom() })];
`;
	const stream = `
const streamDeadline = performance.now() + 15000;
while (!document.querySelector(".tr-tail .tr-row") && performance.now() < streamDeadline) await sleep(100);
const before = dom();
bench.start();
await sleep(${options.streamMs});
const result = bench.stop();
const tail = document.querySelector(".tr-tail");
const lockedAtBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 40;
return [JSON.stringify({ transcriptReadyMs: readyMs, result, streamingRowPresent: Boolean(tail && tail.textContent && tail.textContent.length > 0), lockedAtBottom, dom: dom(), domBefore: before })];
`;
	return `(async () => {${common}${scenario === "scroll" ? scroll : stream}})()`;
}

interface SweepReport {
	results: { issues: string[]; probe?: string[]; console?: string[]; failed_requests?: string[] }[];
}

async function runSweep(
	url: string,
	probe: string,
	options: Options,
	workDir: string,
	name: string,
): Promise<Record<string, unknown>> {
	const sweep = $which("omp-sweep");
	if (!sweep) throw new Error("omp-sweep not found on PATH");
	const probeFile = path.join(workDir, `${name}.probe.js`);
	const outDir = path.join(workDir, name);
	await Bun.write(probeFile, probe);
	const args = [
		sweep,
		"--url",
		url,
		"--widths",
		String(options.width),
		"--themes",
		"dark",
		"--height",
		String(options.height),
		"--probe-only",
		"--probe-file",
		probeFile,
		"--concurrency",
		"1",
		"--wait-ms",
		"500",
		"--timeout",
		"60",
		"--out",
		outDir,
	];
	if (options.chrome !== undefined) args.push("--chrome", options.chrome);
	const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
	await child.exited;
	let report: SweepReport;
	try {
		report = (await Bun.file(path.join(outDir, "report.json")).json()) as SweepReport;
	} catch {
		throw new Error(`omp-sweep produced no report.json\n${stdout}\n${stderr}`);
	}
	const run = report.results[0];
	const payload = run?.probe?.[0];
	if (payload === undefined) {
		throw new Error(`${name}: no probe result; issues: ${JSON.stringify(run?.issues)}\n${stdout}\n${stderr}`);
	}
	const parsed = JSON.parse(payload) as Record<string, unknown>;
	const pageErrors = [...(run?.console ?? []), ...(run?.failed_requests ?? [])];
	return pageErrors.length > 0 ? { ...parsed, pageErrors } : parsed;
}

async function main(): Promise<void> {
	const argv = Bun.argv.slice(2);
	const options = parseOptions(argv);
	if (options.printProbe !== undefined) {
		console.log(probeFor(options.printProbe, options));
		return;
	}

	let baseUrl = options.url;
	let stop: (() => Promise<void>) | undefined;
	if (baseUrl === undefined) {
		if (!(await Bun.file(path.join(options.dist, "index.html")).exists())) {
			throw new Error(`no built assets at ${options.dist}; run \`bun run build\` in packages/web first (or pass --dist/--url)`);
		}
		const daemon = await startMockDaemon({ port: options.port, dist: options.dist, seed: false, fixtures: true, panes: true });
		baseUrl = daemon.url;
		stop = () => daemon.stop();
		console.error(`mock daemon with bench fixtures on ${daemon.url}`);
	}
	const sessionUrl = (id: string): string => (options.url ?? `${baseUrl}/?bench#session=${id}`);

	if (options.serve) {
		console.error(`scroll fixture: ${baseUrl}/?bench#session=${BENCH_TRANSCRIPT_SESSION_ID}`);
		console.error(`stream fixture: ${baseUrl}/?bench#session=${BENCH_STREAM_SESSION_ID}`);
		console.error(`panes fixture: ${baseUrl}/?bench#session=${PANE_SESSION_IDS[0]} (the probe opens ${PANE_SESSION_IDS.length} panes)`);
		console.error("open one on the device, then run `--print-probe scroll|stream` in its web inspector; Ctrl+C stops");
		await new Promise<void>(() => {});
		return;
	}

	const workDir = options.out ?? (await fs.mkdtemp(path.join(os.tmpdir(), "omp-console-bench-")));
	const scenarios: Record<string, unknown> = {};
	try {
		for (const scenario of options.scenarios) {
			const id =
				scenario === "scroll" ? BENCH_TRANSCRIPT_SESSION_ID : scenario === "panes" ? PANE_SESSION_IDS[0]! : BENCH_STREAM_SESSION_ID;
			console.error(`running ${scenario} ...`);
			scenarios[scenario] = await runSweep(sessionUrl(id), probeFor(scenario, options), options, workDir, scenario);
		}
	} finally {
		await stop?.();
	}
	const entries = makeTranscript({ lines: DEFAULT_TRANSCRIPT_LINES });
	console.log(
		JSON.stringify(
			{
				label: "headless Chromium (Playwright via omp-sweep). NOT the rubric's WKWebView / iPhone Safari numbers; use for regressions and relative cost only.",
				viewport: { width: options.width, height: options.height },
				fixture: { transcriptLines: countLines(entries), transcriptEntries: entries.length },
				parameters: {
					scroll: { distancePx: options.scrollPx, durationMsPerLeg: options.scrollMs, legs: "down then up" },
					stream: { tokensPerSecond: 100, measuredMs: options.streamMs },
					panes: { sessions: PANE_SESSION_IDS.length, tokensPerSecondEach: 100, measuredMs: options.streamMs },
				},
				scenarios,
			},
			null,
			2,
		),
	);
}

if (import.meta.main) {
	main().then(
		() => process.exit(0),
		err => {
			console.error(err instanceof Error ? err.message : String(err));
			process.exit(1);
		},
	);
}
