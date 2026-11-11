/** Only same-site relative paths may follow sign-in; anything else lands on the dashboard. */
export function safeAuthDestination(next?: string) {
  return next?.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";
}

/** Request header the proxy sets so server layouts know the address being opened. */
export const REQUEST_PATH_HEADER = "x-sp-path";

/** Sign-in address that returns to `path` afterwards (WEB-007); no `next` when the path is unknown or unsafe. */
export function signInHref(path?: string | null) {
  if (!path || safeAuthDestination(path) !== path || path.startsWith("/login"))
    return "/login";
  return `/login?next=${encodeURIComponent(path)}`;
}
