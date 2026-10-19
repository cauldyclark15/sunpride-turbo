/**
 * URL helpers. Pure functions take the current pathname and params so they
 * are testable without a router; `useUrlState` wires them to Next.
 */

export type ParamPatch = Record<
  string,
  string | readonly string[] | null | undefined
>;

/** A new href: `patch` keys replace (array = repeated param, null = removed); the rest is kept. */
export function withParams(
  pathname: string,
  current: URLSearchParams | string,
  patch: ParamPatch,
): string {
  const next = new URLSearchParams(
    typeof current === "string" ? current : current.toString(),
  );
  for (const [name, value] of Object.entries(patch)) {
    next.delete(name);
    if (value === null || value === undefined) continue;
    if (typeof value === "string") {
      if (value !== "") next.set(name, value);
    } else for (const item of value) next.append(name, item);
  }
  const search = next.toString();
  return search ? `${pathname}?${search}` : pathname;
}

/** Same-site path only (fixture links and action hrefs from the server). */
export function safeHref(href: string | null | undefined): string | null {
  if (!href || !href.startsWith("/") || href.startsWith("//")) return null;
  if ([...href].some((char) => char.charCodeAt(0) < 0x20)) return null;
  return href;
}

/** Keeps the dev fixture flag on internal links so fixture mode survives navigation. */
export function carryFixture(href: string, current: URLSearchParams): string {
  if (current.get("fixture") !== "1" || href.includes("fixture=1")) return href;
  return `${href}${href.includes("?") ? "&" : "?"}fixture=1`;
}
