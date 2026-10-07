/**
 * BETA SAMPLE DATA for the monthly admin report pack (SOP-012; see
 * docs/architecture/ADMIN_REPORT_PACK.md). Made-up programme allocations, priority documents,
 * ADP claims and KAS receivable balances so the four reports work before Sunpride's real
 * Promo Advice, templates, claims and AR source exist. Every row has `source: "sample"` and a
 * `SAMPLE-` code; real rows (`source: "office"`) of the same kind and month replace them
 * automatically. `reset` removes only sample rows.
 *
 * Run from packages/backend (lead only, on the beta deployment):
 *   bunx convex run analytics/admin_pack_sample:seed '{"month":"2026-10"}'
 *   bunx convex run analytics/admin_pack_sample:reset '{}'   # until isDone
 */
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { manilaDate, monthBounds } from "../coverage/validation";
import { SUNPRIDE_ORGANIZATION_ID } from "../inventory/constants";
import { topology } from "../org/validation";
import type { AdminPackRecord } from "./admin_pack_model";

/** Programme references the sample allocations use; field testers record these on visits. */
export const SAMPLE_PROGRAMS = [
  {
    ref: "SAMPLE-PA-01",
    name: "Buy 10 cases sardines, get 1 free (sample)",
    stores: 40,
    budget: 120_000,
  },
  {
    ref: "SAMPLE-PA-02",
    name: "5% off corned beef per case (sample)",
    stores: 30,
    budget: 80_000,
  },
  {
    ref: "SAMPLE-PA-03",
    name: "Pancake mix + syrup bundle (sample)",
    stores: 25,
    budget: 45_000,
  },
  {
    ref: "SAMPLE-PA-04",
    name: "Gondola end display, tomato sauce (sample)",
    stores: 15,
    budget: 60_000,
  },
] as const;

const SAMPLE_ACCOUNTS = [
  { code: "SAMPLE-KA-01", name: "Gaisano Mactan (sample)" },
  { code: "SAMPLE-KA-02", name: "Metro Ayala Cebu (sample)" },
  { code: "SAMPLE-KA-03", name: "SM Seaside Hypermarket (sample)" },
  { code: "SAMPLE-KA-04", name: "Prince Warehouse Club Talisay (sample)" },
  { code: "SAMPLE-KA-05", name: "Robinsons Supermarket Fuente (sample)" },
];

const SAMPLE_PARTNERS = [
  { code: "SAMPLE-ADP-01", name: "Mandaue Distribution Partners (sample)" },
  { code: "SAMPLE-ADP-02", name: "Lapu-Lapu Trading (sample)" },
  { code: "SAMPLE-ADP-03", name: "Toledo Consumer Goods (sample)" },
];

const MAX_CUSTOMERS_SCANNED = 200;
const RESET_BATCH = 200;
const PESO = 100;

/** Key accounts already in the system (their codes match field collections), else made up. */
async function accounts(ctx: MutationCtx) {
  const customers = await ctx.db.query("customers").take(MAX_CUSTOMERS_SCANNED);
  const keyAccounts = customers
    .filter(
      (row) =>
        row.active && /key\s*account|^ka$|modern\s*trade/i.test(row.channel),
    )
    .slice(0, SAMPLE_ACCOUNTS.length)
    .map((row) => ({ code: row.code, name: row.name }));
  return keyAccounts.length ? keyAccounts : SAMPLE_ACCOUNTS;
}

function day(month: string, n: number) {
  return `${month}-${String(n).padStart(2, "0")}`;
}

type NewRecord = AdminPackRecord extends infer R
  ? R extends AdminPackRecord
    ? Omit<
        R,
        "organizationId" | "orgUnitId" | "period" | "source" | "createdAt"
      >
    : never
  : never;

function sampleRecords(
  month: string,
  unitCode: string,
  keyAccounts: { code: string; name: string }[],
): NewRecord[] {
  const out: NewRecord[] = [];
  const code = (kind: string, n: number) =>
    `SAMPLE-${kind}-${unitCode}-${month}-${String(n).padStart(2, "0")}`;
  const names = keyAccounts.length
    ? keyAccounts
    : [{ code: "", name: "Key account (sample)" }];
  SAMPLE_PROGRAMS.forEach((program, i) =>
    out.push({
      kind: "program_allocation",
      code: code("ALLOC", i + 1),
      programRef: program.ref,
      programName: program.name,
      allocatedStores: program.stores,
      budgetMinor: program.budget * PESO,
    }),
  );
  const docs: Array<{
    docType: "da_contract" | "promo_advice" | "coa" | "sasr" | "br_template";
    title: string;
    owner: string;
    due: number;
    status: "pending" | "submitted" | "approved" | "returned";
    submitted: number | null;
  }> = [
    {
      docType: "da_contract",
      title: "Display allowance contract renewal",
      owner: "KAS Cebu (sample)",
      due: 5,
      status: "approved",
      submitted: 3,
    },
    {
      docType: "promo_advice",
      title: "Promo Advice for the month",
      owner: "Trade marketing (sample)",
      due: 1,
      status: "submitted",
      submitted: 1,
    },
    {
      docType: "coa",
      title: "Calendar of Activity",
      owner: "Area sales manager (sample)",
      due: 3,
      status: "approved",
      submitted: 2,
    },
    {
      docType: "sasr",
      title: "Sampling support request, weekend activation",
      owner: "Area sales manager (sample)",
      due: 12,
      status: "returned",
      submitted: 10,
    },
    {
      docType: "br_template",
      title: "Quarterly business review",
      owner: "KAS Cebu (sample)",
      due: 25,
      status: "pending",
      submitted: null,
    },
    {
      docType: "da_contract",
      title: "Gondola end display allowance",
      owner: "KAS Cebu (sample)",
      due: 15,
      status: "pending",
      submitted: null,
    },
  ];
  docs.forEach((doc, i) => {
    const account = names[i % names.length]!;
    out.push({
      kind: "priority_document",
      code: code("PRIO", i + 1),
      docType: doc.docType,
      title: doc.title,
      accountName: account.name,
      ownerName: doc.owner,
      dueDate: day(month, doc.due),
      status: doc.status,
      submittedDate: doc.submitted === null ? null : day(month, doc.submitted),
    });
  });
  const claims: Array<{
    type: "display_allowance" | "promo_discount" | "bad_order" | "rebate";
    filed: number;
    claimed: number;
    approved: number | null;
    status: "filed" | "validated" | "approved" | "paid" | "rejected";
  }> = [
    {
      type: "display_allowance",
      filed: 2,
      claimed: 18_500,
      approved: 18_500,
      status: "paid",
    },
    {
      type: "promo_discount",
      filed: 6,
      claimed: 42_300,
      approved: 40_100,
      status: "approved",
    },
    {
      type: "bad_order",
      filed: 9,
      claimed: 7_850,
      approved: null,
      status: "validated",
    },
    {
      type: "rebate",
      filed: 14,
      claimed: 25_000,
      approved: null,
      status: "filed",
    },
    {
      type: "bad_order",
      filed: 16,
      claimed: 3_200,
      approved: 0,
      status: "rejected",
    },
    {
      type: "promo_discount",
      filed: 20,
      claimed: 31_750,
      approved: null,
      status: "filed",
    },
  ];
  claims.forEach((claim, i) => {
    const partner = SAMPLE_PARTNERS[i % SAMPLE_PARTNERS.length]!;
    out.push({
      kind: "adp_claim",
      code: code("CLAIM", i + 1),
      partnerCode: partner.code,
      partnerName: partner.name,
      claimType: claim.type,
      claimRef: `SAMPLE-CL-${unitCode}-${month.replace("-", "")}-${String(i + 1).padStart(3, "0")}`,
      filedDate: day(month, claim.filed),
      claimedMinor: claim.claimed * PESO,
      approvedMinor: claim.approved === null ? null : claim.approved * PESO,
      status: claim.status,
    });
  });
  keyAccounts.forEach((account, i) => {
    const base = 60_000 + i * 35_000;
    out.push({
      kind: "ar_balance",
      code: code("AR", i + 1),
      customerCode: account.code,
      customerName: account.name,
      asOfDate: day(month, 1),
      termsDays: i % 2 ? 45 : 30,
      currentMinor: base * PESO,
      days1to30Minor: Math.round(base * 0.6) * PESO,
      days31to60Minor: Math.round(base * 0.25 * (i % 3)) * PESO,
      days61to90Minor: i === 2 ? 18_000 * PESO : 0,
      over90Minor: i === 4 ? 9_500 * PESO : 0,
    });
  });
  return out;
}

/**
 * Seeds the sample pack for a Manila month (default: this month). Without `orgUnitId` every
 * region (each child of the national root; the root itself when it has none) gets its own
 * set, so regional managers see their region's sample and national readers see them all.
 * Key accounts are split across the regions. Idempotent: rows whose code already exists are
 * skipped, so running it again adds nothing.
 */
export const seed = internalMutation({
  args: {
    month: v.optional(v.string()),
    orgUnitId: v.optional(v.id("orgUnits")),
  },
  returns: v.object({
    month: v.string(),
    orgUnitIds: v.array(v.id("orgUnits")),
    inserted: v.number(),
    skipped: v.number(),
  }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const month = args.month ?? manilaDate(now).slice(0, 7);
    monthBounds(month);
    let targets: { _id: Id<"orgUnits">; code: string }[];
    if (args.orgUnitId) {
      const unit = await ctx.db.get(args.orgUnitId);
      if (!unit || unit.organizationId !== SUNPRIDE_ORGANIZATION_ID)
        throw new Error("Unknown organization unit");
      targets = [unit];
    } else {
      const tree = await topology(ctx, now);
      const root = tree.find((unit) => !unit.parentId);
      if (!root) throw new Error("No organization tree to attach sample data");
      const regions = tree
        .filter(
          (unit) => unit.parentId === root._id && unit.status === "active",
        )
        .sort((a, b) => a.code.localeCompare(b.code));
      targets = regions.length ? regions : [root];
    }
    const keyAccounts = await accounts(ctx);
    let inserted = 0;
    let skipped = 0;
    for (const [index, unit] of targets.entries()) {
      const mine = keyAccounts.filter((_, i) => i % targets.length === index);
      for (const record of sampleRecords(month, unit.code, mine)) {
        const existing = await ctx.db
          .query("adminPackRecords")
          .withIndex("by_organizationId_and_code", (q) =>
            q
              .eq("organizationId", SUNPRIDE_ORGANIZATION_ID)
              .eq("code", record.code),
          )
          .first();
        if (existing) {
          skipped++;
          continue;
        }
        await ctx.db.insert("adminPackRecords", {
          ...record,
          organizationId: SUNPRIDE_ORGANIZATION_ID,
          orgUnitId: unit._id,
          period: month,
          source: "sample",
          createdAt: now,
        } as AdminPackRecord);
        inserted++;
      }
    }
    return {
      month,
      orgUnitIds: targets.map((unit) => unit._id),
      inserted,
      skipped,
    };
  },
});

/** Removes sample rows only, a batch per call; call again until `isDone`. */
export const reset = internalMutation({
  args: {},
  returns: v.object({ deleted: v.number(), isDone: v.boolean() }),
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("adminPackRecords")
      .withIndex("by_organizationId_and_source", (q) =>
        q.eq("organizationId", SUNPRIDE_ORGANIZATION_ID).eq("source", "sample"),
      )
      .take(RESET_BATCH);
    for (const row of rows) await ctx.db.delete(row._id);
    return { deleted: rows.length, isDone: rows.length < RESET_BATCH };
  },
});
