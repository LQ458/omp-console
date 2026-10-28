import type { WorkerRequestResult } from "@omp-console/protocol";

export type RequestErrorCode = Extract<WorkerRequestResult, { t: "request-error" }>["code"];

/** A request the worker refuses; `code` is the HTTP status class the daemon answers with. */
export class RequestError extends Error {
	override readonly name = "RequestError";
	constructor(
		readonly code: RequestErrorCode,
		message: string,
	) {
		super(message);
	}
}
