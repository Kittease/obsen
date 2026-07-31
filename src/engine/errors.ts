/**
 * One way to turn an unknown thrown value into something a user or a log can read.
 * Ports reject with whatever their environment throws — an `Error`, a string, an
 * axios object — and every layer of the engine needs the same answer.
 */
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
