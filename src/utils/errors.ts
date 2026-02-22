import { log } from "../logger.js";

/**
 * Returns an error handler that logs with context instead of silently swallowing.
 * Use in place of `.catch(() => {})` throughout the codebase.
 *
 * @example
 *   promise.catch(logError("sendMessage"));
 *   // logs: "sendMessage error: <message>"
 */
export function logError(context: string): (err: unknown) => void {
  return (err: unknown) => {
    log({ message: `${context} error: ${err instanceof Error ? err.message : String(err)}` });
  };
}
