import { ArrowLeft, Send } from "lucide-react";
import type { ReactNode } from "react";
import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AgentNode } from "../../lib/agent-graph";
import type { DeckApi } from "../../lib/api";
import type { GuestClient } from "../../lib/client";
import type { PlanTaskNode } from "../../lib/plan-graph";
import { SheetWindowRootContext } from "../shell/Sheet";
import { ChangeModel } from "./ChangeModel";
import { openSpawnPanel } from "./graph-events";
import { trackGraph } from "./graph-usage";
import {
	ASK_PROGRESS_MESSAGE,
	agentMenuItems,
	type MenuCaps,
	type MenuItem,
	splitTaskMessage,
	taskMenuItems,
} from "./node-actions";
import { OmpEquivalent } from "./OmpEquivalent";
import "./graph-tools.css";

const MENU_WIDTH = 320;
const ROW_HEIGHT = 84;
const EDGE = 8;
const NOTICE_MS = 1300;

/** Where a menu was asked for and for what. */
export type MenuRequest =
	| { kind: "agent"; nodeId: string; x: number; y: number }
	| { kind: "task"; taskId: string; x: number; y: number };

/** What the menu actions talk to. */
export interface InstructContext {
	api: DeckApi;
	client: GuestClient;
	/** Daemon session id; absent for a manually joined link. */
	sessionId: string | undefined;
	readOnly: boolean;
	/** Registry id of the main agent (target of "split into subtasks"). */
	mainId: string | undefined;
	/** Opens the agent drawer. */
	onOpenAgent(id: string): void;
}

function caps(ctx: InstructContext): MenuCaps {
	return { readOnly: ctx.readOnly, hasSession: ctx.sessionId !== undefined };
}

/** Keeps the menu on screen: below-right of the pointer, flipped or pushed back when it would overflow. */
export function placeMenu(x: number, y: number, rows: number, viewport: { width: number; height: number }): { left: number; top: number } {
	const height = rows * ROW_HEIGHT + 16;
	const left = Math.max(EDGE, Math.min(x, viewport.width - MENU_WIDTH - EDGE));
	const top = Math.max(EDGE, Math.min(y, viewport.height - height - EDGE));
	return { left, top };
}

function MenuShell(props: {
	x: number;
	y: number;
	rows: number;
	label: string;
	onClose(): void;
	children: ReactNode;
}): ReactNode {
	const { x, y, rows, label, onClose, children } = props;
	const sheetWindowRoot = useContext(SheetWindowRootContext);
	const ref = useRef<HTMLDivElement | null>(null);
	const layerRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === "Escape") {
				event.stopPropagation();
				onClose();
			}
		};
		window.addEventListener("keydown", onKey, true);
		ref.current?.focus({ preventScroll: true });
		return () => window.removeEventListener("keydown", onKey, true);
	}, [onClose]);
	const viewport =
		typeof window === "undefined" ? { width: 1280, height: 800 } : { width: window.innerWidth, height: window.innerHeight };
	const { left, top } = placeMenu(x, y, rows, viewport);
	// `placeMenu` only estimates the height (wrapped lines, composer); once laid out, pull the real box back on screen.
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		el.style.top = `${top}px`;
		const overflow = el.getBoundingClientRect().bottom - (window.innerHeight - EDGE);
		if (overflow > 0) el.style.top = `${Math.max(EDGE, top - overflow)}px`;
	});

	useLayoutEffect(() => {
		const layer = layerRef.current;
		if (layer === null || sheetWindowRoot !== null || typeof layer.showPopover !== "function") return;
		try {
			layer.showPopover();
		} catch {
			layer.removeAttribute("popover");
			return;
		}
		return () => {
			try {
				if (layer.matches(":popover-open")) layer.hidePopover();
			} catch {
				// Older engines keep the menu in its body portal with the existing z-index fallback.
			}
		};
	}, [sheetWindowRoot]);
	const body = (
		<div ref={layerRef} className="ag-menu-root" popover={sheetWindowRoot === null ? "manual" : undefined}>
			<div
				className="ag-menu-backdrop"
				onPointerDown={event => {
					event.preventDefault();
					onClose();
				}}
				onContextMenu={event => {
					event.preventDefault();
					onClose();
				}}
			/>
			<div
				ref={ref}
				className="ag-menu"
				role="menu"
				aria-label={label}
				tabIndex={-1}
				style={{ left, top, width: MENU_WIDTH }}
			>
				{children}
			</div>
		</div>
	);
	// A sheet may be transformed (slide-up), which would anchor `position: fixed` to the sheet instead of the viewport.
	return typeof document === "undefined" ? body : createPortal(body, sheetWindowRoot ?? document.body);
}

function Items(props: { items: MenuItem[]; onRun(id: string): void; armed?: string | null }): ReactNode {
	const { items, onRun, armed } = props;
	return (
		<>
			{items.map(item => (
				<div key={item.id} className={item.danger ? "ag-menu-item ag-menu-item--danger" : "ag-menu-item"}>
					<button
						type="button"
						role="menuitem"
						className="ag-menu-run"
						disabled={!item.enabled}
						title={item.enabled ? undefined : item.reason}
						onClick={() => onRun(item.id)}
					>
						{armed === item.id ? `Click again to ${item.label.toLowerCase()}` : item.label}
						{!item.enabled && item.reason ? <span className="ag-menu-reason">{item.reason}</span> : null}
					</button>
					<OmpEquivalent text={item.equivalent} />
				</div>
			))}
		</>
	);
}

function Composer(props: {
	title: string;
	placeholder: string;
	omp: string;
	onSend(text: string): void;
	onBack(): void;
}): ReactNode {
	const { title, placeholder, omp, onSend, onBack } = props;
	const [text, setText] = useState("");
	const send = (): void => {
		const trimmed = text.trim();
		if (trimmed !== "") onSend(trimmed);
	};
	return (
		<div className="ag-menu-compose">
			<div className="ag-menu-compose-head">
				<button type="button" className="ag-iconbtn" aria-label="back to the menu" onClick={onBack}>
					<ArrowLeft size={15} aria-hidden />
				</button>
				<span>{title}</span>
			</div>
			<textarea
				className="ag-menu-textarea"
				value={text}
				placeholder={placeholder}
				aria-label={title}
				// biome-ignore lint/a11y/noAutofocus: the person just chose "Message"; typing should start at once
				autoFocus
				rows={3}
				onChange={event => setText(event.target.value)}
				onKeyDown={event => {
					if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
						event.preventDefault();
						send();
					}
				}}
			/>
			<div className="ag-menu-compose-foot">
				<OmpEquivalent text={omp} />
				<button type="button" className="ag-btn" disabled={text.trim() === ""} onClick={send}>
					<Send size={13} aria-hidden /> Send
				</button>
			</div>
		</div>
	);
}

function useNotice(onClose: () => void): { notice: string | null; show(text: string): void } {
	const [notice, setNotice] = useState<string | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (timer.current !== null) clearTimeout(timer.current);
		},
		[],
	);
	return {
		notice,
		show(text: string) {
			setNotice(text);
			timer.current = setTimeout(onClose, NOTICE_MS);
		},
	};
}

/** Right-click / long-press menu of an agent node: message, ask, change model, kill, revive, open transcript. */
export function AgentNodeMenu(props: { node: AgentNode; x: number; y: number; ctx: InstructContext; onClose(): void }): ReactNode {
	const { node, x, y, ctx, onClose } = props;
	const [mode, setMode] = useState<"list" | "message" | "model">("list");
	const [armed, setArmed] = useState<string | null>(null);
	const { notice, show } = useNotice(onClose);
	const items = agentMenuItems(node, caps(ctx));
	const track = (action: string): void => trackGraph("4.4.instruct", action, { detail: "agent-node", sessionId: ctx.sessionId });

	const run = (id: string): void => {
		switch (id) {
			case "message":
				setMode("message");
				return;
			case "model":
				setMode("model");
				return;
			case "ask":
				ctx.client.sendAgentCmd("chat", node.id, ASK_PROGRESS_MESSAGE);
				track("ask-progress");
				show(`Asked ${node.displayName} for progress.`);
				return;
			case "kill":
				if (armed !== "kill") {
					setArmed("kill");
					return;
				}
				ctx.client.sendAgentCmd("kill", node.id);
				track("kill");
				show(`Killed ${node.displayName}.`);
				return;
			case "revive":
				ctx.client.sendAgentCmd("revive", node.id);
				track("revive");
				show(`Reviving ${node.displayName}.`);
				return;
			case "transcript":
				track("open-transcript");
				ctx.onOpenAgent(node.id);
				onClose();
		}
	};

	return (
		<MenuShell x={x} y={y} rows={mode === "list" ? items.length : 4} label={`${node.displayName} actions`} onClose={onClose}>
			<div className="ag-menu-title">{node.displayName}</div>
			{notice !== null ? (
				<div className="ag-menu-notice" role="status">
					{notice}
				</div>
			) : mode === "message" ? (
				<Composer
					title={`Message ${node.displayName}`}
					placeholder="Steer this agent. It reads this at its next step."
					omp={`/hub, select ${node.displayName}, then type`}
					onBack={() => setMode("list")}
					onSend={text => {
						ctx.client.sendAgentCmd("chat", node.id, text);
						track("message");
						show(`Sent to ${node.displayName}.`);
					}}
				/>
			) : mode === "model" && ctx.sessionId !== undefined ? (
				<div className="ag-menu-model">
					<button type="button" className="ag-iconbtn" aria-label="back to the menu" onClick={() => setMode("list")}>
						<ArrowLeft size={15} aria-hidden />
					</button>
					<ChangeModel sessionId={ctx.sessionId} agentId={node.id} agentName={node.displayName} currentModel={node.model} api={ctx.api} defaultOpen />
					<OmpEquivalent text="/agents (per-agent model)" />
				</div>
			) : (
				<Items items={items} onRun={run} armed={armed} />
			)}
		</MenuShell>
	);
}

/** Menu of a plan task node: do this now, split into subtasks, assign to a profile, open the inferred agent. */
export function TaskNodeMenu(props: {
	task: PlanTaskNode;
	x: number;
	y: number;
	ctx: InstructContext;
	onClose(): void;
}): ReactNode {
	const { task, x, y, ctx, onClose } = props;
	const { notice, show } = useNotice(onClose);
	const items = taskMenuItems({ content: task.content, agentName: task.agent?.agentName }, caps(ctx));
	const track = (action: string): void => trackGraph("4.4.instruct", action, { detail: "plan-task", sessionId: ctx.sessionId });

	const run = (id: string): void => {
		switch (id) {
			case "do-now":
				openSpawnPanel({ task: task.content });
				track("do-now");
				onClose();
				return;
			case "assign":
				openSpawnPanel({ task: task.content, focus: "profile" });
				track("assign-profile");
				onClose();
				return;
			case "split": {
				const text = splitTaskMessage(task.content);
				try {
					if (ctx.mainId !== undefined) ctx.client.sendAgentCmd("chat", ctx.mainId, text);
					else ctx.client.sendPrompt(text);
				} catch (error) {
					show(error instanceof Error ? error.message : "Could not ask the main agent.");
					return;
				}
				track("split");
				show("Asked the main agent to split this task.");
				return;
			}
			case "open-agent":
				if (task.agent) ctx.onOpenAgent(task.agent.agentId);
				track("open-linked-agent");
				onClose();
		}
	};

	return (
		<MenuShell x={x} y={y} rows={items.length} label="task actions" onClose={onClose}>
			<div className="ag-menu-title ag-menu-title--task">{task.content}</div>
			{notice !== null ? (
				<div className="ag-menu-notice" role="status">
					{notice}
				</div>
			) : (
				<Items items={items} onRun={run} />
			)}
		</MenuShell>
	);
}
