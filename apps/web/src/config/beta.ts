import type { WebModuleSlug } from "./navigation";

/**
 * Beta release (SP-0123): the beta feature list.
 *
 * Everything listed here is HIDDEN from client testers, not deleted — the code stays in
 * place. To switch one back on, either remove it from this list, or set
 * `NEXT_PUBLIC_BETA_ENABLE` to a comma-separated list of keys (or `all`) and rebuild the
 * web app. See `apps/web/docs/BETA_RELEASE.md`.
 */
export const BETA_HIDDEN_FEATURES = {
  integration:
    "Integration (SAP) module: the sidebar item and the /sap-integration page",
  "sap-status":
    "Reports → Management exceptions: the SAP failures card and the SAP stock differences line",
  "stock-differences":
    "Inventory → Adjustments: the Differences panel (compares our stock with SAP)",
  "inventory-setup":
    "Inventory: the Set up button that creates the starter warehouses",
  production:
    "Inventory → Production tab (a list only; production orders cannot be created here)",
  "sample-order":
    "Orders: the New order button (it added a fixed sample order, not a real one)",
  "cash-variances":
    "Reports → Management exceptions: the Cash variances card (cash is not recorded yet)",
  "dsr-new-products":
    "Daily sales report: the empty New products box (waiting for Sunpride's list)",
} as const;

export type BetaFeature = keyof typeof BETA_HIDDEN_FEATURES;

/** Modules whose whole route is hidden, with the feature that switches them back on. */
const HIDDEN_MODULES: Partial<Record<WebModuleSlug, BetaFeature>> = {
  "sap-integration": "integration",
};

function enabledList(): string[] {
  // Read with a literal public variable name so Next inlines it into the client bundle.
  return (process.env.NEXT_PUBLIC_BETA_ENABLE ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
}

/** True when a hidden beta feature has been switched back on. */
export function isBetaFeatureOn(feature: BetaFeature): boolean {
  const enabled = enabledList();
  return enabled.includes("all") || enabled.includes(feature);
}

/** True when the module's route and navigation are hidden for the beta. */
export function isModuleHiddenForBeta(slug: string): boolean {
  if (!Object.hasOwn(HIDDEN_MODULES, slug)) return false;
  const feature = (HIDDEN_MODULES as Record<string, BetaFeature>)[slug]!;
  return !isBetaFeatureOn(feature);
}

/** Where to download the Android apps. Empty hides the download section. */
export function betaApkUrl(): string | null {
  const url = (process.env.NEXT_PUBLIC_BETA_APK_URL ?? "").trim();
  return /^https?:\/\//i.test(url) ? url : null;
}

const MAX_FROM_LENGTH = 300;

/** A same-site page path only; anything else (absolute URLs, `//host`) is dropped. */
export function safeReportedFrom(from: string | null | undefined) {
  if (!from || !from.startsWith("/") || from.startsWith("//")) return null;
  if ([...from].some((char) => char.charCodeAt(0) < 0x20)) return null;
  return from.slice(0, MAX_FROM_LENGTH);
}

/** The "Report an issue" link for the page the tester is on. */
export function reportIssueHref(pathname: string | null | undefined) {
  const from = safeReportedFrom(pathname);
  return from && !from.startsWith("/issues")
    ? `/issues/new?from=${encodeURIComponent(from)}`
    : "/issues/new";
}

/** The description a new issue starts with when it was reported from a page. */
export function reportedFromDescription(from: string | null | undefined) {
  const page = safeReportedFrom(from);
  return page ? `Page: ${page}\n\n` : "";
}
