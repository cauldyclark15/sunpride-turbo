/** Only same-site relative paths may follow sign-in; anything else lands on the dashboard. */
export function safeAuthDestination(next?: string) {
  return next?.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";
}
