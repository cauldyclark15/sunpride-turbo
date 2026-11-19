import { formatStatus, formatTime } from "../../lib/format";

export const SIGN_IN_APPS: Record<string, string> = {
  web: "Website",
  "field-android": "Field app (Android)",
  "field-ios": "Field app (iPhone)",
  "van-android": "Van / Store app",
  "office-ios": "Office app (iPhone)",
};
export const SIGN_IN_ROLES = ["super_admin", "admin", "manager"];
export const REPORT_ROLES = [
  "super_admin",
  "admin",
  "operations",
  "manager",
  "approver",
  "sales",
  "analyst",
  "viewer",
];
export type SignInPerson = {
  profileId: string;
  name: string;
  role: string;
  orgUnitId: string | null;
  branch: string;
  apps: string[];
  signIns: number;
  firstSignInAt: number | null;
  lastActivityAt: number | null;
  activityNotRetained: boolean;
};
export type SignInsReport = {
  date: string;
  app: string | null;
  role: string | null;
  orgUnitId: string | null;
  units: { id: string; name: string }[];
  signedIn: SignInPerson[];
  didNotSignIn: SignInPerson[];
};
export function activityLabel(person: SignInPerson) {
  return person.activityNotRetained
    ? "Not retained for this day"
    : formatTime(person.lastActivityAt);
}

// Quote every cell, preserve Unicode/Excel BOM, and prevent spreadsheet formulas even after whitespace.
function cell(value: unknown) {
  const raw = String(value ?? "");
  const safe =
    /^[\s\uFEFF]*[=+\-@]/.test(raw) || /^[\t\r\n]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}
export function signInsCsv(report: SignInsReport) {
  const rows: unknown[][] = [
    [
      "Date (Manila)",
      "App filter",
      "Role filter",
      "Branch filter",
      "Status",
      "Name",
      "Role",
      "Branch",
      "Apps used",
      "First sign-in (Manila)",
      "Last activity (Manila)",
      "Sign-ins",
    ],
  ];
  for (const [status, people] of [
    ["Signed in", report.signedIn],
    ["Did not sign in", report.didNotSignIn],
  ] as const) {
    for (const person of people)
      rows.push([
        report.date,
        report.app ? (SIGN_IN_APPS[report.app] ?? report.app) : "All apps",
        report.role ? formatStatus(report.role) : "All roles",
        report.units.find((u) => u.id === report.orgUnitId)?.name ??
          "All branches",
        status,
        person.name,
        formatStatus(person.role),
        person.branch,
        person.apps.map((app) => SIGN_IN_APPS[app] ?? app).join("; "),
        formatTime(person.firstSignInAt),
        activityLabel(person),
        person.signIns,
      ]);
  }
  return (
    "\uFEFF" + rows.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n"
  );
}
