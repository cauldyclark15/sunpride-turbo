import { afterAll, beforeAll, expect, test } from "bun:test";
import { startHarness } from "./harness.js";
import { domainInstallers } from "../src/domains/index.js";
import { ROLES } from "../src/core/capabilities.js";
import { sha256Hex } from "../src/core/util.js";
import { seedDemo } from "../../../packages/db/seed/index.js";
import { rowId, todayManila } from "../../../packages/db/seed/store.js";

// Load the actual web navigation, not a second hand-maintained visibility table.
// Variable paths keep web TS sources outside the API's plain-JS type graph.
const accessPath = new URL(
  "../../web/src/lib/module-access.ts",
  import.meta.url,
).href;
const navPath = new URL("../../web/src/config/navigation.ts", import.meta.url)
  .href;
const { canAccessWebModule } = await import(accessPath);
const { getWebNavigation } = await import(navPath);
/** @type {Awaited<ReturnType<typeof startHarness>>} */ let h;
const date = todayManila(),
  month = date.slice(0, 7);
/** @param {string} name @param {any} [args] */
const report = (name, args = {}) =>
  `/api/v1/fieldreports/${name.replaceAll(".", "/")}?args=${encodeURIComponent(JSON.stringify(args))}`;
/** Every Work tab's initial business read(s). Keep this exhaustive when a tab is added.
 * Browser proof additionally exercises the real mounted hooks, including dependent reads.
 * @type {Record<string,string[]>} */
const calls = {
  // F-402: Channel Development's initial partner-scoped listing.
  distributors: ["/api/v1/distributors"],
  "finance-claims": [
    "/api/v1/tpm/claims",
    "/api/v1/tpm/summary",
    "/api/v1/tpm/policies",
    "/api/v1/tpm/options",
    "/api/v1/tpm/liabilities",
    "/api/v1/tpm/deductions",
    "/api/v1/tpm/incentives",
  ],
  // F-306 F-307 F-309: real mounted reads for the MT Work tab.
  "modern-trade": [
    "/api/v1/mt/options",
    "/api/v1/mt/intake",
    "/api/v1/mt/terms",
    "/api/v1/mt/deductions",
  ],
  orders: [
    "/api/v1/orders/list",
    "/api/v1/orders/filter-options",
    "/api/v1/analytics/sales",
  ],
  workflows: [
    "/api/v1/orders/list?status=pending_approval",
    "/api/v1/van/damage",
  ],
  "sales-force": [
    "/api/v1/coverage/permissions",
    "/api/v1/coverage/profile",
    `/api/v1/coverage/summary?month=${month}`,
    "/api/v1/coverage/pjp", // F-201 existing workspace tab
    "/api/v1/coverage/productive-policies", // F-208 existing workspace tab
  ],
  supervision: [
    report("supervision.team.options", { serviceDate: date }),
    report("supervision.team.cockpit", { serviceDate: date }),
  ],
  "call-sheets": [report("callSheets.accounts.list")],
  "daily-sales": [report("dsr.report.salesmen", { serviceDate: date })],
  "activity-reports": [
    report("field_reports.reports.myKind"),
    report("lib.capabilities.currentPermissions"),
  ],
  training: [report("supervision.trainer_forms.mine")],
  inventory: ["/api/v1/inventory/overview", "/api/v1/inventory/locations"],
  imports: ["/api/v1/imports/options"],
  "outside-calls": [
    "/api/v1/orders/outside-calls/list?status=awaiting_activity",
  ],
  "van-trips": [`/api/v1/van/trips?date=${date}`],
  // F-310 F-316: every visible role reads the real scoped retail landing page.
  "retail-execution": ["/api/v1/retail/workspace"],
  agencies: ["/api/v1/partners"], // F-319 F-322: dependent agency reads are covered by partners.test.js
};
beforeAll(async () => {
  h = await startHarness({ installers: domainInstallers });
  await seedDemo(h.db, { anchorDate: date, days: 3 });
}, 120000);
afterAll(async () => {
  await h?.close();
});
for (const role of ROLES)
  test(`${role}: every visible Work tab's real data requests are allowed`, async () => {
    const [u] =
      await h.db`insert into users(email,password_hash) values(${role + "@tab-parity.test"},'not-a-login') returning id`;
    const unit = rowId(
      "org_units",
      role === "manager" ? "territory-0" : "national",
    );
    const [p] =
      await h.db`insert into profiles(user_id,auth_subject,name,email,role,status,org_unit_id,position_id) values(${u.id},${u.id},${role},${role + "@tab-parity.test"},${role},'active',${unit},${rowId("positions", "CDS")}) returning id`;
    await h.db`insert into employee_assignments(profile_id,org_unit_id,role,position_id,effective_from,actor_subject,reason) values(${p.id},${unit},${role},${rowId("positions", "CDS")},'2020-01-01','test','Role/tab parity fixture')`;
    const token = "sps_" + crypto.randomUUID();
    await h.db`insert into sessions(user_id,token_hash,app,expires_at) values(${u.id},${sha256Hex(token)},'web',now()+interval '1 hour')`;
    const nav = getWebNavigation("/orders", (/** @type {string} */ slug) =>
      canAccessWebModule(slug, role),
    );
    expect(nav.moduleTabs.length).toBeGreaterThan(0);
    for (const tab of nav.moduleTabs) {
      expect(
        calls[tab.id],
        `Missing read coverage for tab ${tab.id}`,
      ).toBeDefined();
      for (const path of calls[tab.id]) {
        const res = await h.fetch(path, {
          headers: { cookie: `sp_session=${token}` },
        });
        const body = /** @type {any} */ (await res.json());
        expect(
          res.status,
          `${role} × ${tab.id}: ${path}: ${JSON.stringify(body.error)}`,
        ).toBe(200);
        if (
          tab.id === "sales-force" &&
          path.includes("/summary") &&
          ["analyst", "viewer"].includes(role)
        )
          expect(
            body.rows.some((/** @type {any} */ r) =>
              ["Start plan", "Edit revision"].includes(r.action.label),
            ),
          ).toBe(false);
      }
    }
    // Also cover the dependent personal/team DAR and DSR reads after permissions load.
    const dependent =
      role === "sales"
        ? [
            report("field_reports.reports.day", {
              serviceDate: date,
              profileId: p.id,
            }),
          ]
        : canAccessWebModule("activity-reports", role)
          ? [report("field_reports.reports.completeness", { endDate: date })]
          : [];
    for (const path of dependent)
      expect(
        (await h.fetch(path, { headers: { cookie: `sp_session=${token}` } }))
          .status,
      ).toBe(200);
  }, 60000);
