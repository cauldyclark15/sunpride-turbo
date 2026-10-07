import { convexTest, type TestConvex } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { modules } from "../test.setup";
import { manilaDate } from "../coverage/validation";

type T = TestConvex<typeof schema>;
type Json = { type: string; [key: string]: unknown };
type Field = { fieldType: Json; optional: boolean };
type Caller = ReturnType<T["withIdentity"]> | T;

const MARK = "LEAK·";
const DAY = 86_400_000;

type PublicFn = { path: string; kind: "query" | "mutation"; args: Json };

async function publicFunctions(): Promise<PublicFn[]> {
  const out: PublicFn[] = [];
  for (const [file, load] of Object.entries(modules)) {
    if (
      /(^|\/)(_generated\/|convex\.config|auth\.config|schema\.ts|crons\.ts)/.test(
        file,
      )
    )
      continue;
    const mod = (await load()) as Record<string, unknown>;
    const base = file.replace(/^\.\//, "").replace(/\.ts$/, "");
    for (const [name, fn] of Object.entries(mod)) {
      const f = fn as {
        isPublic?: boolean;
        isQuery?: boolean;
        isMutation?: boolean;
        exportArgs?: () => string;
      } | null;
      if (!f || !f.isPublic || !f.exportArgs) continue;
      if (!f.isQuery && !f.isMutation) continue;
      out.push({
        path: `${base}:${name}`,
        kind: f.isQuery ? "query" : "mutation",
        args: JSON.parse(f.exportArgs()) as Json,
      });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Tables whose rows are not owned by an organizational unit. */
const STRUCTURAL = new Set([
  "orgUnits",
  "orgUnitTypes",
  "orgUnitParentEdges",
  "profiles",
  "employeeAssignments",
  "issueCounters",
]);

function makeValue(
  v: Json,
  path: string,
  resolve: (table: string) => string,
): unknown {
  switch (v.type) {
    case "id":
      return resolve(v.tableName as string);
    case "string":
      return path.endsWith(".organizationId") ? "sunpride" : `${MARK}${path}`;
    case "number":
      return Date.now() - 30 * DAY;
    case "bigint":
      return 1n;
    case "boolean":
      return true;
    case "null":
      return null;
    case "literal":
      return v.value;
    case "any":
      return `${MARK}${path}`;
    case "bytes":
      return new ArrayBuffer(0);
    case "array":
      return [];
    case "record":
      return {};
    case "union": {
      const options = v.value as Json[];
      const pick = options.find((o) => o.type !== "null") ?? options[0];
      return makeValue(pick, path, resolve);
    }
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [k, f] of Object.entries(v.value as Record<string, Field>)) {
        if (f.optional && f.fieldType.type !== "id") continue;
        out[k] = makeValue(f.fieldType, `${path}.${k}`, resolve);
      }
      return out;
    }
    default:
      throw new Error(`unsupported validator ${v.type}`);
  }
}

const today = () => manilaDate(Date.now());

function makeArg(
  v: Json,
  name: string,
  resolve: (table: string) => string,
  last = false,
): unknown {
  switch (v.type) {
    case "id":
      return resolve(v.tableName as string);
    case "string":
      if (/month/i.test(name)) return today().slice(0, 7);
      if (/date|day/i.test(name)) return today();
      return "LEAK";
    case "number":
      if (/numItems|limit|count|size/i.test(name)) return 10;
      return Date.now();
    case "bigint":
      return 1n;
    case "boolean":
      return false;
    case "null":
      return null;
    case "literal":
      return v.value;
    case "any":
      return {};
    case "bytes":
      return new ArrayBuffer(0);
    case "array":
      return [makeArg(v.value as Json, name, resolve, last)];
    case "record":
      return {};
    case "union": {
      const options = v.value as Json[];
      const values = options.filter((o) => o.type !== "null");
      const pick =
        options.find((o) => o.type === "null") ??
        (last ? values[values.length - 1] : values[0]);
      return makeArg(pick, name, resolve, last);
    }
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [k, f] of Object.entries(v.value as Record<string, Field>)) {
        if (f.optional && !containsId(f.fieldType)) continue;
        out[k] = makeArg(f.fieldType, k, resolve, last);
      }
      return out;
    }
    default:
      throw new Error(`unsupported validator ${v.type}`);
  }
}

function containsId(v: Json): boolean {
  if (v.type === "id") return true;
  if (v.type === "array") return containsId(v.value as Json);
  if (v.type === "union") return (v.value as Json[]).some(containsId);
  return false;
}

type Role =
  | "admin"
  | "operations"
  | "manager"
  | "approver"
  | "sales"
  | "analyst"
  | "viewer";

async function fixture() {
  const t: T = convexTest(schema, modules);
  await t.mutation(internal.migrations.bootstrapSuperAdmin, {});
  const root = t.withIdentity({ subject: "root", email: "jcing.jc@gmail.com" });
  await root.mutation(api.domains.profiles.ensure, {});
  const { rootUnitId } = await t.mutation(
    internal.migrations.seedOrganizationFoundation,
    {},
  );
  const since = Date.now() - 60 * DAY;
  const [north, south, position] = await t.run(async (ctx) => {
    const unit = (code: string) =>
      ctx.db.insert("orgUnits", {
        organizationId: "sunpride",
        code,
        name: code,
        typeCode: "REGION",
        parentId: rootUnitId,
        status: "active",
        effectiveFrom: since,
        createdAt: since,
        updatedAt: since,
      });
    return [
      await unit("NORTH"),
      await unit("SOUTH"),
      await ctx.db.insert("positions", {
        organizationId: "sunpride",
        code: "PSR",
        label: "PSR",
        category: "field",
        active: true,
        createdAt: since,
        updatedAt: since,
      }),
    ];
  });

  async function person(role: Role, name: string, unit: Id<"orgUnits"> | null) {
    const email = `${name}@example.test`;
    await root.mutation(api.domains.profiles.invite, { email, role });
    const actor = t.withIdentity({ subject: name, email });
    await actor.mutation(api.domains.profiles.ensure, {});
    const profile = (await actor.query(api.domains.profiles.current, {}))!;
    await t.run(async (ctx) => {
      for (const prior of await ctx.db
        .query("employeeAssignments")
        .withIndex("by_profileId_and_effectiveFrom", (q) =>
          q.eq("profileId", profile._id),
        )
        .collect())
        await ctx.db.delete(prior._id);
      if (!unit) {
        await ctx.db.patch(profile._id, { orgUnitId: undefined, role });
        return;
      }
      await ctx.db.patch(profile._id, { orgUnitId: unit, role });
      await ctx.db.insert("employeeAssignments", {
        profileId: profile._id,
        orgUnitId: unit,
        role,
        positionId: position,
        effectiveFrom: since,
        actorSubject: "fixture",
        reason: "fixture",
        createdAt: since,
      });
    });
    return { actor, id: profile._id };
  }

  const northSales = await person("sales", "north-sales", north);

  // One generic row per unit-owned table, every reference pointing at North.
  const tables = (
    JSON.parse((schema as unknown as { export(): string }).export()) as {
      tables: { tableName: string; documentType: Json }[];
    }
  ).tables;
  const ids: Record<string, string> = {};
  await t.run(async (ctx) => {
    ids._storage = await ctx.storage.store(new Blob(["north evidence"]));
  });
  const fixed: Record<string, string> = {
    orgUnits: north,
    profiles: northSales.id,
    positions: position,
  };
  const placeholder = (table: string) =>
    fixed[table] ?? ids[table] ?? `9${table}`;
  const generated = tables.filter(
    (table) => !STRUCTURAL.has(table.tableName) && !fixed[table.tableName],
  );
  await t.run(async (ctx) => {
    for (const table of generated) {
      const doc = makeValue(table.documentType, table.tableName, placeholder);
      ids[table.tableName] = await ctx.db.insert(
        table.tableName as "visits",
        doc as never,
      );
    }
    for (const table of generated) {
      const doc = makeValue(table.documentType, table.tableName, placeholder);
      await ctx.db.replace(ids[table.tableName] as Id<"visits">, doc as never);
    }
  });
  const resolve = (table: string) => fixed[table] ?? ids[table] ?? `9${table}`;

  const callers: Record<string, Caller> = {
    anonymous: t,
    unprovisioned: t.withIdentity({
      subject: "stranger",
      email: "stranger@example.test",
    }),
    unassignedManager: (await person("manager", "floating-manager", null))
      .actor,
    southAdmin: (await person("admin", "south-admin", south)).actor,
    southOperations: (await person("operations", "south-ops", south)).actor,
    southManager: (await person("manager", "south-manager", south)).actor,
    southApprover: (await person("approver", "south-approver", south)).actor,
    southSales: (await person("sales", "south-sales", south)).actor,
    southViewer: (await person("viewer", "south-viewer", south)).actor,
    analyst: (await person("analyst", "analyst", south)).actor,
    root,
    northAdmin: (await person("admin", "north-admin", north)).actor,
    northOperations: (await person("operations", "north-ops", north)).actor,
    northManager: (await person("manager", "north-manager", north)).actor,
    northApprover: (await person("approver", "north-approver", north)).actor,
    northSales: northSales.actor,
    northViewer: (await person("viewer", "north-viewer", north)).actor,
  };
  return { t, callers, resolve, ids, north, south };
}

function errorText(error: unknown) {
  if (error && typeof error === "object" && "data" in error)
    return String((error as { data: unknown }).data);
  return error instanceof Error ? error.message : String(error);
}

type CallerName = keyof Awaited<ReturnType<typeof fixture>>["callers"];
type Outcome = {
  path: string;
  kind: "query" | "mutation";
  ok: boolean;
  /** Unit-owned North tables whose marker text or row id reached the caller. */
  leaked: string[];
  /** Any North marker, including national catalogue tables. */
  anyMarker: boolean;
  error?: string;
};

const json = (value: unknown) =>
  JSON.stringify(value ?? null, (_k, v: unknown) =>
    typeof v === "bigint" ? `${v}n` : v,
  );

/**
 * National catalogue and organization-wide tables: readable by design without a unit
 * (RBAC_SCOPE_MATRIX.md — the product catalog, UOM and inventory policy under
 * `inventory.read`, position standards for the scorecard, the org-wide issue tracker).
 */
const GLOBAL_TABLES = new Set([
  "products",
  "unitsOfMeasure",
  "uomConversions",
  "productBarcodes",
  "productInventoryPolicies",
  "positions",
  "positionStandards",
  "visitActivityRules",
  // ANA-009: national per-SKU promotion uplifts feeding the suggested order.
  "suggestedOrderPromotions",
  "issues",
  "issueComments",
  "issueAttachments",
  "issueActivity",
]);

const sweeps = new Map<CallerName, Promise<Outcome[]>>();

function sweep(callerName: CallerName) {
  const cached = sweeps.get(callerName);
  if (cached) return cached;
  const run = (async () => {
    const fns = await publicFunctions();
    const { callers, resolve, ids, north } = await fixture();
    const watched: Record<string, string> = { ...ids, orgUnits: north };
    delete watched._storage;
    const caller = callers[callerName];
    const out: Outcome[] = [];
    // Two argument variants: the first and the last option of every union (role,
    // status, decision literals), so a validation branch cannot mask a missing gate.
    for (const fn of fns)
      for (const last of [false, true]) {
        const args = makeArg(fn.args, "", resolve, last) as Record<
          string,
          unknown
        >;
        const argText = json(args);
        try {
          const result =
            fn.kind === "query"
              ? await caller.query(
                  makeFunctionReference<"query">(fn.path),
                  args,
                )
              : await caller.mutation(
                  makeFunctionReference<"mutation">(fn.path),
                  args,
                );
          const text = json(result);
          const markerTables = (text.match(/LEAK·\w+/g) ?? []).map((m) =>
            m.slice(MARK.length),
          );
          const idTables = Object.entries(watched)
            .filter(([, id]) => text.includes(id) && !argText.includes(id))
            .map(([table]) => table);
          out.push({
            path: fn.path,
            kind: fn.kind,
            ok: true,
            anyMarker: markerTables.length > 0,
            leaked: [...new Set([...markerTables, ...idTables])].filter(
              (table) => !GLOBAL_TABLES.has(table),
            ),
          });
        } catch (error) {
          out.push({
            path: fn.path,
            kind: fn.kind,
            ok: false,
            anyMarker: false,
            leaked: [],
            error: errorText(error),
          });
        }
      }
    return out;
  })();
  sweeps.set(callerName, run);
  return run;
}

/** Signed out, or signed in without a Sunpride profile: only these answer, with null. */
const ANONYMOUS_NULL_QUERIES = [
  "domains/profiles:current",
  "mobile/devices:mine",
];

/**
 * Mutations a caller may complete with every reference pointing at another region,
 * because they touch only the caller's own records or organization-wide data.
 */
const SELF_SERVICE = ["domains/profiles:ensure"];
const ISSUE_WRITERS = ["issues/mutations:generateUploadUrl"];
const FIELD_RECORDERS = [
  "outlets/enrolment:generateUploadUrl", // storage URL only; attaching is scoped
  "supervision/talk_sheet:create", // always files in the caller's own unit
];
const ALLOWED_MUTATIONS: Partial<Record<CallerName, string[]>> = {
  unassignedManager: [
    ...SELF_SERVICE,
    ...ISSUE_WRITERS,
    "outlets/enrolment:generateUploadUrl",
  ],
  // The issue tracker is organization-wide (`issues.manage` = G for admin).
  southAdmin: [
    ...SELF_SERVICE,
    ...ISSUE_WRITERS,
    "issues/mutations:restore",
    "issues/mutations:update",
  ],
  southOperations: [...SELF_SERVICE, ...ISSUE_WRITERS],
  southManager: [...SELF_SERVICE, ...ISSUE_WRITERS, ...FIELD_RECORDERS],
  southApprover: [...SELF_SERVICE, ...ISSUE_WRITERS],
  // Beta (SP-0123): every role files tester feedback in the organization-wide tracker.
  southSales: [...SELF_SERVICE, ...ISSUE_WRITERS, ...FIELD_RECORDERS],
  southViewer: [...SELF_SERVICE, ...ISSUE_WRITERS],
  analyst: [...SELF_SERVICE, ...ISSUE_WRITERS],
};

const OUTSIDERS = [
  "unassignedManager",
  "southAdmin",
  "southOperations",
  "southManager",
  "southApprover",
  "southSales",
  "southViewer",
] as const;
const INSIDERS = [
  "northAdmin",
  "northOperations",
  "northManager",
  "northApprover",
  "northSales",
  "northViewer",
] as const;

/**
 * QSR-006 role/scope matrix sweep. Every public query and mutation is called by
 * every role from outside the data's region, with every id argument pointing at a
 * row owned by the North region. A North caller of the same role is the positive
 * control proving the fixture rows are reachable at all.
 */
describe("authorization sweep (QSR-006)", () => {
  // The sweep grows with every public function; same bound as the per-role sweeps below.
  it(
    "refuses every public function to signed-out and unprovisioned callers",
    { timeout: 120_000 },
    async () => {
      for (const caller of ["anonymous", "unprovisioned"] as const) {
        const answered = (await sweep(caller)).filter((o) => o.ok);
        expect(
          [...new Set(answered.map((o) => o.path))].sort(),
          caller,
        ).toEqual([...ANONYMOUS_NULL_QUERIES].sort());
        expect(
          answered.every((o) => !o.anyMarker),
          caller,
        ).toBe(true);
      }
    },
  );

  it.each(OUTSIDERS)(
    "%s never reads another region's rows",
    { timeout: 120_000 },
    async (caller) => {
      const leaks = [
        ...new Set(
          (await sweep(caller))
            .filter((o) => o.leaked.length > 0)
            .map((o) => `${o.path} → ${o.leaked.join(",")}`),
        ),
      ];
      expect(leaks).toEqual([]);
    },
  );

  it.each([...OUTSIDERS, "analyst"] as const)(
    "%s completes no write against another region",
    { timeout: 120_000 },
    async (caller) => {
      const writes = [
        ...new Set(
          (await sweep(caller))
            .filter((o) => o.kind === "mutation" && o.ok)
            .map((o) => o.path),
        ),
      ].sort();
      expect(writes).toEqual([...(ALLOWED_MUTATIONS[caller] ?? [])].sort());
    },
  );

  it(
    "analyst reads across regions but holds no write",
    { timeout: 120_000 },
    async () => {
      const outcomes = await sweep("analyst");
      expect(
        outcomes.filter((o) => o.ok && o.leaked.length > 0).length,
      ).toBeGreaterThan(20);
    },
  );

  it(
    "positive control: the same reads return North rows to North callers",
    { timeout: 300_000 },
    async () => {
      const seenByInsider = new Set<string>();
      for (const caller of INSIDERS)
        for (const o of await sweep(caller))
          if (o.kind === "query" && o.leaked.length > 0)
            seenByInsider.add(o.path);
      const seenByOutsider = new Set<string>();
      for (const caller of OUTSIDERS)
        for (const o of await sweep(caller))
          if (o.leaked.length > 0) seenByOutsider.add(o.path);
      // Each of these reads demonstrably filters by region rather than returning
      // nothing for everybody. The floor guards against a fixture regression that
      // would silently turn the sweep into a no-op.
      expect(seenByInsider.size).toBeGreaterThanOrEqual(60);
      expect([...seenByInsider].filter((p) => seenByOutsider.has(p))).toEqual(
        [],
      );
      for (const path of [
        "coverage/plans:detail",
        "outlets/queries:list",
        "outlets/queries:detail",
        "territories/queries:list",
        "territories/routes:detail",
        "inventory/queries:locations",
        "inventory/transfers:list",
        "callSheets/accounts:list",
        "dsr/report:day",
        "teams/queries:list",
        "targets/sales:list",
        "supervision/work_with:detail",
      ])
        expect(seenByInsider, path).toContain(path);
    },
  );
});
