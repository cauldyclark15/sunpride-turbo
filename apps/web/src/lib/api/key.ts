/**
 * Cache keys are arrays of JSON values, e.g. `["issues", "board", { status }]`.
 * A string is shorthand for a one-element key. `null` (or `false`/`undefined`)
 * means "skip": no request, `data` stays `undefined`.
 */
export type ApiKey = readonly unknown[];
export type ApiKeyInput = ApiKey | string | null | undefined | false;

export function normalizeKey(input: ApiKeyInput): ApiKey | null {
  if (input === null || input === undefined || input === false) return null;
  return typeof input === "string" ? [input] : input;
}

/** Deterministic hash: object keys sorted, undefined members dropped. */
export function hashKey(key: ApiKey): string {
  return JSON.stringify(key, (_name, value: unknown) => {
    if (typeof value === "bigint") return value.toString();
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const sorted: Record<string, unknown> = {};
      for (const name of Object.keys(value).sort())
        sorted[name] = (value as Record<string, unknown>)[name];
      return sorted;
    }
    return value;
  });
}

export function parseKeyHash(hash: string): ApiKey {
  return JSON.parse(hash) as ApiKey;
}

/**
 * Prefix match: `["issues"]` matches every key starting with "issues";
 * `["issue", 142]` matches `["issue", 142, "comments"]` but not `["issue", 143]`.
 */
export function keyMatches(key: ApiKey, pattern: ApiKey): boolean {
  if (pattern.length > key.length) return false;
  return pattern.every(
    (part, index) => hashKey([part]) === hashKey([key[index]]),
  );
}
