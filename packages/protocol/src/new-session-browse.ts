/** `GET /api/new-session/browse?dir=` → visible child folders within the home or a configured project root. */
export interface NewSessionBrowseResponse {
	dir: string;
	home: string;
	parent?: string;
	entries: Array<{ name: string; path: string }>;
	truncated: boolean;
}
