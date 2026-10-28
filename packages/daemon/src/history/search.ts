/**
 * Full-text search over session titles and key points. Every term must occur somewhere (title, card title, or the
 * card body: goal, decisions, files, outcome, open questions). Ranking is lexicographic: terms found in a title come
 * first (so a title hit always outranks any amount of body text), then terms found in the card body, then recency.
 */
import type { HistoryNode } from "@omp-console/protocol";

export function tokenize(query: string): string[] {
	return query
		.toLowerCase()
		.split(/\s+/)
		.map(term => term.trim())
		.filter(term => term !== "");
}

function bodyText(node: HistoryNode): string {
	const card = node.keyPoints;
	if (!card) return "";
	return [card.goal ?? "", ...card.decisions, ...card.files, card.outcome ?? "", ...card.openQuestions].join("\n").toLowerCase();
}

export interface Match {
	node: HistoryNode;
	titleHits: number;
	bodyHits: number;
}

/** The match of `node` against `terms`, or `undefined` when a term occurs nowhere. */
export function matchNode(node: HistoryNode, terms: readonly string[]): Match | undefined {
	const title = `${node.title}\n${node.keyPoints?.title ?? ""}`.toLowerCase();
	const body = bodyText(node);
	let titleHits = 0;
	let bodyHits = 0;
	for (const term of terms) {
		if (title.includes(term)) titleHits++;
		else if (body.includes(term)) bodyHits++;
		else return undefined;
	}
	return { node, titleHits, bodyHits };
}

/** Matching nodes, best first. */
export function search(nodes: readonly HistoryNode[], query: string): HistoryNode[] {
	const terms = tokenize(query);
	if (terms.length === 0) return [...nodes];
	const matches: Match[] = [];
	for (const node of nodes) {
		const match = matchNode(node, terms);
		if (match) matches.push(match);
	}
	matches.sort((a, b) => b.titleHits - a.titleHits || b.bodyHits - a.bodyHits || b.node.lastActivityAt - a.node.lastActivityAt);
	return matches.map(match => match.node);
}
