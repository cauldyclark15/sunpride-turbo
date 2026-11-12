import { ApiError } from "../../lib/api/errors";

/**
 * One sentence for a failed supervision command (WEB-120). The API's refusal
 * ("This position has no Work-With standard") is shown as written; only a
 * transport failure (no response) falls back to the generic retry text.
 */
export function commandErrorText(error: unknown) {
  const data = (error as { data?: unknown })?.data;
  if (typeof data === "string") return data;
  if (error instanceof ApiError)
    return error.status > 0 && error.message
      ? error.message
      : "Not saved. Check your connection and try again.";
  return "Not saved. Try again.";
}
