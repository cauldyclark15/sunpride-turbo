export function safeAuthDestination(next?: string) {
  return next?.startsWith("/") && !next.startsWith("//")
    ? next
    : "/dashboard";
}
