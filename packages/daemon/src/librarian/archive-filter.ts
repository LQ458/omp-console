function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Filter archived ids from the librarian's web-facing card and away-brief lists. */
export async function excludeArchivedLibrarianRows(
	response: Response,
	pathname: string,
	isArchived: (sessionId: string) => boolean,
): Promise<Response> {
	if (response.status !== 200 || (pathname !== "/api/cards" && pathname !== "/api/brief")) return response;
	let body: unknown;
	try {
		body = await response.clone().json();
	} catch {
		return response;
	}
	if (!isRecord(body)) return response;
	const field = pathname === "/api/cards" ? "cards" : "lines";
	const rows = body[field];
	if (!Array.isArray(rows)) return response;
	const filtered = rows.filter(row => !isRecord(row) || typeof row.sessionId !== "string" || !isArchived(row.sessionId));
	if (filtered.length === rows.length) return response;
	const headers = new Headers(response.headers);
	headers.set("content-type", "application/json");
	return new Response(JSON.stringify({ ...body, [field]: filtered }), {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
