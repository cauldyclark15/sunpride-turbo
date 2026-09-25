export const EXCEPTION_POLICY_SOURCE =
  "Provisional Group 06 policy; pending client sign-off";
export type ExceptionCode =
  | "missing_gps"
  | "duplicate_location"
  | "territory_only"
  | "inactive_outlet"
  | "inactive_customer"
  | "conflicting_assignment"
  | "invalid_date"
  | "invalid_cadence"
  | "route_mismatch";
export type Severity = "blocking" | "advisory";
// Provisional defaults; configure here after the client approves GPS/route/duplicate rules.
export const DEFAULT_SEVERITIES: Readonly<Record<ExceptionCode, Severity>> = {
  missing_gps: "advisory",
  duplicate_location: "advisory",
  territory_only: "advisory",
  inactive_outlet: "blocking",
  inactive_customer: "blocking",
  conflicting_assignment: "blocking",
  invalid_date: "blocking",
  invalid_cadence: "blocking",
  route_mismatch: "blocking",
};
export function severityFor(
  code: ExceptionCode,
  overrides: Partial<Record<ExceptionCode, Severity>> = {},
): Severity {
  return overrides[code] ?? DEFAULT_SEVERITIES[code];
}
/** Duplicate points within ~1.1m latitude and longitude at the equator (5 decimals).
 * This is a heuristic, never a GPS correction or approval blocker by default. */
export function coordinateKey(latitude: number, longitude: number): string {
  return `${latitude.toFixed(5)},${longitude.toFixed(5)}`;
}
