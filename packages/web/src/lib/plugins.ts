import type { DeckPanelDescriptor, ExtensionUiState, PluginInfo } from "@omp-console/protocol";

const KIND_ORDER: readonly PluginInfo["kind"][] = ["plugin", "extension", "skill", "mcp", "hook", "tool"];

export interface PluginGroup {
	kind: PluginInfo["kind"];
	label: string;
	plugins: PluginInfo[];
}

export function groupPlugins(plugins: readonly PluginInfo[]): PluginGroup[] {
	const groups: PluginGroup[] = [];
	for (const kind of KIND_ORDER) {
		const items = plugins
			.filter(plugin => plugin.kind === kind)
			.slice()
			.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
		if (items.length > 0) groups.push({ kind, label: kind === "mcp" ? "MCP servers" : `${kind}s`, plugins: items });
	}
	return groups;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function stringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
}

function finiteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/** Runtime guard for extension JSON. Unknown descriptors must become a visible error, never arbitrary DOM. */
export function isDeckPanelDescriptor(value: unknown): value is DeckPanelDescriptor {
	if (!record(value) || typeof value.kind !== "string" || typeof value.title !== "string") return false;
	switch (value.kind) {
		case "list":
			return Array.isArray(value.items) && value.items.every(item => record(item) && typeof item.label === "string" && (item.detail === undefined || typeof item.detail === "string"));
		case "kv":
			return Array.isArray(value.rows) && value.rows.every(row => record(row) && typeof row.key === "string" && typeof row.value === "string");
		case "progress":
			return finiteNumber(value.value) && finiteNumber(value.max) && (value.label === undefined || typeof value.label === "string");
		case "markdown":
			return typeof value.text === "string";
		case "table": {
			const columns = value.columns;
			if (!stringArray(columns) || !Array.isArray(value.rows)) return false;
			return value.rows.every(row => stringArray(row) && row.length === columns.length);
		}
		case "buttons":
			return Array.isArray(value.buttons) && value.buttons.every(button => record(button) && typeof button.label === "string" && typeof button.command === "string" && button.command.trim() !== "");
		default:
			return false;
	}
}

export function descriptorError(value: unknown): string | null {
	return isDeckPanelDescriptor(value) ? null : "This extension published an invalid omp console panel descriptor.";
}

export function visibleExtensionPanels(state: ExtensionUiState | null): Array<{ key: string; descriptor: DeckPanelDescriptor }> {
	if (!state) return [];
	return state.panels.map(panel => ({ key: panel.key, descriptor: panel.descriptor })).filter(panel => isDeckPanelDescriptor(panel.descriptor));
}

export function extensionStatusText(state: ExtensionUiState | null): string[] {
	return state?.statuses.map(status => status.text).filter(text => text.trim() !== "") ?? [];
}
