import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SignIns, SignInsView } from "./sign-ins";
import { SupervisionWorkspace } from "./supervision-workspace";
import { signInsCsv, type SignInsReport } from "./sign-ins-model";
import { splitCsv } from "../../lib/csv";

const mock = vi.hoisted(() => ({
  role: "manager",
  search: "?tab=signins&date=2026-11-17",
  data: undefined as SignInsReport | undefined,
  error: undefined as { message: string } | undefined,
  useApi: vi.fn(),
  apiFetch: vi.fn(),
  download: vi.fn(),
  report: vi.fn(),
}));
vi.mock("../../lib/auth/session", () => ({
  useOptionalRole: () => mock.role,
  useSession: () => ({
    profile: { id: "manager", role: mock.role },
    me: { scope: { fingerprint: "current-scope" } },
  }),
}));
vi.mock("../../lib/api", () => ({
  useApi: (...args: unknown[]) => {
    mock.useApi(...args);
    return {
      data: mock.data,
      error: mock.error,
      refetch: async () => {},
      isFetching: false,
    };
  },
  apiFetch: (...args: unknown[]) => mock.apiFetch(...args),
}));
vi.mock("../../lib/import-csv-export", () => ({
  downloadCsv: (...args: unknown[]) => mock.download(...args),
}));
vi.mock("./report-api", () => ({
  useReportSearch: () => mock.search,
  replaceReportSearch: vi.fn(),
  useReport: (...args: unknown[]) => {
    mock.report(...args);
    return undefined;
  },
}));
vi.mock("./team-execution", () => ({
  TeamExecution: () => <div>Team view</div>,
}));
vi.mock("./report-depth", () => ({ MyTeam: () => null }));

const at = (time: string) => Date.parse(`2026-11-17T${time}+08:00`);
const data: SignInsReport = {
  date: "2026-11-17",
  app: null,
  role: null,
  orgUnitId: null,
  units: [{ id: "a", name: "Area A" }],
  signedIn: [
    {
      profileId: "p1",
      name: 'Ana, "A"',
      role: "sales",
      orgUnitId: "a",
      branch: "Area A",
      apps: ["web", "field-android"],
      signIns: 2,
      firstSignInAt: at("08:00:00"),
      lastActivityAt: at("17:00:00"),
      activityNotRetained: false,
    },
  ],
  didNotSignIn: [
    {
      profileId: "p2",
      name: "Ben",
      role: "sales",
      orgUnitId: "a",
      branch: "Area A",
      apps: [],
      signIns: 0,
      firstSignInAt: null,
      lastActivityAt: null,
      activityNotRetained: false,
    },
  ],
};
beforeEach(() => {
  vi.clearAllMocks();
  mock.role = "manager";
  mock.data = data;
  mock.error = undefined;
  mock.search = "?tab=signins&date=2026-11-17";
});
describe("Sign-ins report", () => {
  it("renders one row per person with Manila times, readable apps and both sections", () => {
    const html = renderToStaticMarkup(<SignInsView data={data} />);
    expect(html).toContain("8:00 AM");
    expect(html).toContain("5:00 PM");
    for (const label of [
      "Signed in",
      "Did not sign in",
      "Ana",
      "Ben",
      "Sales",
      "Area A",
      "Website",
      "Field app (Android)",
      "First sign-in",
      "Last activity",
      "Export CSV",
    ])
      expect(html).toContain(label);
    expect(html).not.toContain("sps_");
    expect(html).not.toContain("2026-11-17T");
    expect(html).toContain("not an attendance or online-status report");
  });
  it("shows honest unavailable activity and empty states rather than fabricated daily times", () => {
    const unknown = {
      ...data,
      signedIn: [
        {
          ...data.signedIn[0]!,
          lastActivityAt: null,
          activityNotRetained: true,
        },
      ],
    };
    expect(renderToStaticMarkup(<SignInsView data={unknown} />)).toContain(
      "Not retained for this day",
    );
    const html = renderToStaticMarkup(
      <SignInsView data={{ ...data, signedIn: [], didNotSignIn: [] }} />,
    );
    expect(html).toContain("No sign-ins on this date");
    expect(html).toContain(
      "No active sales people without a sign-in match these filters",
    );
  });
  it.each(["super_admin", "admin", "manager"])(
    "opens the Field team tab and filters for %s without loading unrelated reports",
    (role) => {
      mock.role = role;
      const html = renderToStaticMarkup(<SupervisionWorkspace />);
      expect(html).toContain("Sign-ins");
      expect(html).toContain('value="2026-11-17"');
      for (const label of ["Sign-ins branch", "Sign-ins role", "Sign-ins app"])
        expect(html).toContain(label);
      expect(html).not.toContain("My team only");
      expect(mock.report).toHaveBeenCalledWith(
        "supervision.team.options",
        "skip",
      );
      const [key, fetcher] = mock.useApi.mock.calls[0]!;
      expect(key).toEqual([
        "sign-ins",
        "manager",
        "current-scope",
        { date: "2026-11-17", orgUnitId: "", role: "", app: "" },
      ]);
      fetcher({ signal: undefined });
      expect(mock.apiFetch).toHaveBeenCalledWith("/api/v1/people/sign-ins", {
        query: { date: "2026-11-17", orgUnitId: "", role: "", app: "" },
        signal: undefined,
      });
    },
  );
  it.each(["sales", "operations", "approver", "analyst", "viewer"])(
    "hides the tab and rejects a direct request in the page for %s",
    (role) => {
      mock.role = role;
      const html = renderToStaticMarkup(<SupervisionWorkspace />);
      expect(html).not.toContain("Sign-ins");
      expect(mock.useApi).not.toHaveBeenCalled();
      expect(renderToStaticMarkup(<SignIns date={data.date} />)).toContain(
        "administrators and managers",
      );
      expect(mock.useApi.mock.lastCall?.[0]).toBeNull();
    },
  );
  it("does not show stale rows or offer an export after access is refused", () => {
    mock.error = { message: "Choose a branch within your access" };
    const html = renderToStaticMarkup(<SignIns date={data.date} />);
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("Export CSV");
    expect(html).not.toContain("Ana, &quot;A&quot;");
    mock.error = undefined;
    mock.data = undefined;
    expect(renderToStaticMarkup(<SignIns date={data.date} />)).toContain(
      "Loading sign-ins",
    );
  });
  it("exports exactly the displayed sections and filters with safe RFC-4180 cells", () => {
    const report = { ...data, app: "web", role: "sales", orgUnitId: "a" };
    const csv = signInsCsv(report);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    const rows = splitCsv(csv.slice(1));
    expect(rows).toHaveLength(3);
    expect(rows[1]).toEqual([
      "2026-11-17",
      "Website",
      "Sales",
      "Area A",
      "Signed in",
      'Ana, "A"',
      "Sales",
      "Area A",
      "Website; Field app (Android)",
      "8:00 AM",
      "5:00 PM",
      "2",
    ]);
    expect(rows[2]![4]).toBe("Did not sign in");
    expect(rows[2]![5]).toBe("Ben");
    const malicious = {
      ...data,
      signedIn: [
        {
          ...data.signedIn[0]!,
          name: ' \t=HYPERLINK("bad")',
          branch: "@command\nbranch",
          activityNotRetained: true,
        },
      ],
    };
    const escaped = splitCsv(signInsCsv(malicious).slice(1));
    expect(escaped[1]![5]).toBe('\' \t=HYPERLINK("bad")');
    expect(escaped[1]![7]).toBe("'@command\nbranch");
    expect(escaped[1]![10]).toBe("Not retained for this day");
  });
  it("the Export CSV button invokes the download with the complete current report", () => {
    const view = SignInsView({ data });
    const header = view.props.children[0];
    const button = header.props.children[1];
    button.props.onClick();
    expect(mock.download).toHaveBeenCalledWith(
      "sign-ins-2026-11-17.csv",
      signInsCsv(data),
    );
  });
});
