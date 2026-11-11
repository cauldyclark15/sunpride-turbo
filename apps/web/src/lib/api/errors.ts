/**
 * Normalized API error. Every failure the data layer surfaces — an error
 * envelope from the Bun API (`{"error":{"code","message","retryable"}}`), a
 * network failure, an aborted request or a malformed response — becomes one
 * of these, so feature code branches on `code`, never on transport details.
 */
export class ApiError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  /** HTTP status, or 0 when no response arrived (network, abort, parse). */
  readonly status: number;
  /** The envelope's `details` when the server sent one (e.g. `{ errors: [...] }` on 422). */
  readonly details: unknown;

  constructor(init: {
    code: string;
    message: string;
    retryable?: boolean;
    status?: number;
    details?: unknown;
  }) {
    super(init.message);
    this.name = "ApiError";
    this.code = init.code;
    this.retryable = init.retryable ?? false;
    this.status = init.status ?? 0;
    this.details = init.details;
  }

  toJSON(): NormalizedError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
  }
}

export type NormalizedError = {
  code: string;
  message: string;
  retryable: boolean;
};

const STATUS_CODES: Record<number, string> = {
  400: "invalid",
  401: "unauthenticated",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  422: "business_rule",
  429: "rate_limited",
};

/** Default retryability when the server did not say: rate limits and 5xx only. */
function retryableStatus(status: number) {
  return status === 429 || status >= 500;
}

/** Builds an ApiError from an HTTP status and a parsed (possibly absent) body. */
export function errorFromResponse(status: number, body: unknown): ApiError {
  const envelope =
    body && typeof body === "object" && "error" in body
      ? (body as { error: unknown }).error
      : undefined;
  if (envelope && typeof envelope === "object") {
    const { code, message, retryable, details } = envelope as Record<
      string,
      unknown
    >;
    return new ApiError({
      code: typeof code === "string" && code ? code : statusCode(status),
      message:
        typeof message === "string" && message
          ? message
          : defaultMessage(status),
      retryable:
        typeof retryable === "boolean" ? retryable : retryableStatus(status),
      status,
      details,
    });
  }
  return new ApiError({
    code: statusCode(status),
    message: defaultMessage(status),
    retryable: retryableStatus(status),
    status,
  });
}

function statusCode(status: number) {
  return (
    STATUS_CODES[status] ?? (status >= 500 ? "server_error" : "http_error")
  );
}

function defaultMessage(status: number) {
  if (status === 401) return "Sign in again to continue.";
  if (status === 403) return "You do not have access to this.";
  if (status === 404) return "Not found.";
  if (status === 429) return "Too many requests. Try again shortly.";
  if (status >= 500) return "Something went wrong. Try again.";
  return "The request could not be completed.";
}

/** Turns anything thrown into an ApiError, keeping an existing one as-is. */
export function normalizeError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (isAbortError(error))
    return new ApiError({
      code: "aborted",
      message: "The request was cancelled.",
      retryable: true,
    });
  if (error instanceof TypeError)
    return new ApiError({
      code: "network_error",
      message: "Could not reach the server. Check your connection.",
      retryable: true,
    });
  return new ApiError({
    code: "unknown_error",
    message:
      error instanceof Error && error.message
        ? error.message
        : "Something went wrong. Try again.",
    retryable: false,
  });
}

export function isAbortError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name: unknown }).name === "AbortError"
  );
}

export function isApiError(error: unknown, code?: string): error is ApiError {
  return (
    error instanceof ApiError && (code === undefined || error.code === code)
  );
}
