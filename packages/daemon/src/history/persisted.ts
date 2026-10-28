/** Persisted omp sessions (`SessionManager.listAll`) with the fork parent from each session header. */
import { listSessionInfos } from "../recent";
import type { PersistedSession } from "./ports";

export type PersistedLister = () => Promise<PersistedSession[]>;

export const listPersisted: PersistedLister = async () => {
	const infos = await listSessionInfos();
	return infos.map(info => {
		const session: PersistedSession = {
			id: info.id,
			file: info.path,
			cwd: info.cwd,
			createdAt: info.created.getTime(),
			modifiedAt: info.modified.getTime(),
		};
		if (info.title !== undefined) session.title = info.title;
		if (info.parentSessionPath !== undefined) session.parentSession = info.parentSessionPath;
		if (info.firstMessage) session.firstMessage = info.firstMessage;
		return session;
	});
};
