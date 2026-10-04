// Connector errors flow into the console log, the local SQLite queue, the
// unauthenticated /health endpoint and Convex (task acknowledgements and
// heartbeats). None of those may ever carry a configured credential, so every
// error is reduced to a bounded, redacted message before it leaves the service.

export const REDACTED = "[REDACTED]";
export const MAX_ERROR_LENGTH = 500;

/** Values that must never appear in connector logs or reported errors. */
export function secretsFromConfig(config) {
  const secrets = [config.signingSecret, config.sapPassword];
  if (config.sapUsername && config.sapPassword)
    secrets.push(btoa(`${config.sapUsername}:${config.sapPassword}`));
  return secrets.filter(
    (value) => typeof value === "string" && value.length >= 4,
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function createRedactor(secrets = []) {
  const variants = new Set();
  for (const secret of secrets) {
    variants.add(secret);
    variants.add(encodeURIComponent(secret));
  }
  // Longest first so a secret that contains another is removed whole.
  const ordered = [...variants]
    .filter((value) => value.length >= 4)
    .sort((left, right) => right.length - left.length);
  const known = ordered.length
    ? new RegExp(ordered.map(escapeRegExp).join("|"), "g")
    : null;
  return function redact(value) {
    let text =
      value instanceof Error
        ? value.message
        : typeof value === "string"
          ? value
          : String(value);
    if (known) text = text.replace(known, REDACTED);
    text = text
      .replace(/\b(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`)
      .replace(
        /(["']?(?:password|passwd|secret|token|authorization)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&}]+)/gi,
        `$1${REDACTED}`,
      );
    return text.length > MAX_ERROR_LENGTH
      ? `${text.slice(0, MAX_ERROR_LENGTH)}…`
      : text;
  };
}
