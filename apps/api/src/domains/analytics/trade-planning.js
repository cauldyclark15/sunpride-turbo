// SEAM(SAP): primary shipment replicas retain source identity; no operational SAP posting is fabricated.
// SEAM(DISTRIBUTOR): wire current partner financial grants and secondary/stock replicas here.
// SEAM(PROGRAMME): promotion plans remain source-provided inputs, never inferred campaigns.
import { inputObject, uuidInput } from "./inputs.js";
import { xlsx } from "./xlsx.js";
import { tx } from "@sunpride/db/client";
import { requireCapability } from "../../core/capabilities.js";
import { ApiError } from "../../core/errors.js";
import { sha256Hex } from "../../core/util.js";
import { dateOf, addDays, kpi, pct, scopeFor, periodFor } from "./measures.js";
import { availabilityModel } from "./availability-adapter.js";

/** F-603 SEAM(DISTRIBUTOR/SAP): source-line commercial replica reader, never a transaction writer.
 * Current outlet ownership is checked independently of historical source dimensions.
 * Sales users have no partner financial grant; return no trade records to them.
 * @param {any} db @param {any} p @param {any} s */
export async function readTradeInputs(db, p, s) {
  if (s.ownProfileId) return [];
  return db`select f.*,pr.code product_code,pr.name product_name,pr.quantity_scale,
    u.code base_uom,o.name outlet_name,o.territory_id,o.territory_name,
    coalesce(pack.numerator/pack.denominator,1) case_units,
    pack.numerator is not null case_known
    from analytics_trade_inputs f join products pr on pr.id=f.product_id and pr.deleted_at is null
    left join units_of_measure u on u.id=pr.base_uom_id
    left join lateral(select c.numerator::numeric,c.denominator::numeric from uom_conversions c join units_of_measure unit on unit.id=c.from_uom_id where c.product_id=pr.id and upper(unit.code) in ('CS','CASE','CASES') and c.active and c.deleted_at is null and c.effective_from<=f.source_effective_at and (c.effective_to is null or c.effective_to>f.source_effective_at) order by c.effective_from desc limit 1) pack on true
    left join analytics_store_scope o on o.id=f.outlet_id
    where f.org_unit_id in ${db(s.ids.length ? s.ids : [null])}
    and (f.outlet_id is null or o.owner_unit_id in ${db(s.ids.length ? s.ids : [null])})
    and f.service_date between ${p.from} and ${p.to}
    and (${p.channel}::text is null or coalesce(f.channel,o.channel)=${p.channel})`;
}
/** @param {any[]} facts @param {number} days */
export function tradeRows(facts, days) {
  /** @type {Map<string,any>} */ const groups = new Map();
  for (const f of facts) {
    const key = `${f.distributor_key}:${f.product_id}`;
    if (!groups.has(key))
      groups.set(key, {
        key,
        distributor: f.distributor_name,
        distributorKey: f.distributor_key,
        productId: f.product_id,
        product: f.product_name,
        channel: f.channel ?? "Unassigned",
        account: f.account_name ?? f.distributor_name,
        primaryBase: 0,
        secondaryBase: 0,
        primaryCentavos: 0,
        secondaryCentavos: 0,
        primaryKnown: true,
        secondaryKnown: true,
        stockBase: null,
        stockDate: null,
        oldestReceivedAt: null,
        sample: false,
        lineage: [],
        caseUnits: Number(f.case_units) * Number(f.quantity_scale ?? 1),
        caseKnown: f.case_known,
      });
    const g = groups.get(key),
      qty = Number(f.quantity_base);
    if (f.kind === "primary" || f.kind === "secondary") {
      g[f.kind + "Seen"] = true;
      g[f.kind + "Base"] += qty;
      g[f.kind + "Centavos"] += Number(f.amount_centavos ?? 0);
      if (f.amount_centavos === null) g[f.kind + "Known"] = false;
    }
    if (
      f.kind === "stock" &&
      (g.stockDate === null || dateOf(f.service_date) > g.stockDate)
    ) {
      g.stockBase = qty;
      g.stockDate = dateOf(f.service_date);
    } else if (f.kind === "stock" && dateOf(f.service_date) === g.stockDate)
      g.stockBase += qty;
    const received = new Date(f.source_received_at).getTime();
    g.oldestReceivedAt =
      g.oldestReceivedAt === null
        ? received
        : Math.min(received, g.oldestReceivedAt);
    g.sample ||= f.source_type === "sample";
    g.lineage.push({
      id: f.id,
      system: f.source_system,
      key: f.source_key,
      revision: f.source_revision,
      kind: f.kind,
      receivedAt: received,
      source: f.lineage,
    });
  }
  return [...groups.values()].map((g) => ({
    ...g,
    primaryBase: g.primarySeen ? g.primaryBase : null,
    secondaryBase: g.secondarySeen ? g.secondaryBase : null,
    primaryCentavos: g.primaryKnown && g.primarySeen ? g.primaryCentavos : null,
    secondaryCentavos:
      g.secondaryKnown && g.secondarySeen ? g.secondaryCentavos : null,
    primaryCases:
      g.caseKnown && g.primarySeen ? g.primaryBase / g.caseUnits : null,
    secondaryCases:
      g.caseKnown && g.secondarySeen ? g.secondaryBase / g.caseUnits : null,
    stockCases:
      g.caseKnown && g.stockBase !== null ? g.stockBase / g.caseUnits : null,
    daysInventory:
      g.stockBase !== null && g.secondaryBase > 0
        ? Math.round((g.stockBase / (g.secondaryBase / days)) * 10) / 10
        : null,
    nextAction:
      g.stockBase === null
        ? "Request stock declaration"
        : g.secondaryBase <= 0
          ? "Review no offtake"
          : "Reconcile shipments and offtake",
  }));
}
/** @param {any} ctx @param {any} p @param {any} s */
export async function primarySecondaryPage(ctx, p, s) {
  const [facts, before] = await Promise.all([
    readTradeInputs(ctx.db, p, s),
    readTradeInputs(ctx.db, { ...p, ...p.compare }, s),
  ]);
  const rows = tradeRows(facts, p.days),
    prior = tradeRows(before, p.days);
  const total = (/** @type {any[]} */ rs, /** @type {string} */ key) =>
    rs.length && rs.every((r) => r[key] !== null)
      ? rs.reduce((n, r) => n + r[key], 0)
      : null;
  const trend = [];
  for (let d = p.from; d <= p.to; d = addDays(d, 1)) {
    const rs = tradeRows(
      facts.filter((/** @type {any} */ f) => dateOf(f.service_date) === d),
      1,
    );
    trend.push({
      date: d,
      primary: total(rs, "primaryCentavos"),
      secondary: total(rs, "secondaryCentavos"),
    });
  }
  return {
    definitionVersion: "commercial/v1",
    demo: facts.some((/** @type {any} */ f) => f.source_type === "sample"),
    sourceMode: facts.length ? "Source replicas" : "Awaiting source data",
    kpis: [
      kpi(
        "primary",
        "Shipments to distributors",
        total(rows, "primaryCentavos"),
        "php",
        null,
        total(prior, "primaryCentavos"),
        "Source primary shipment line values; not ordinary captured orders.",
      ),
      kpi(
        "secondary",
        "Retailer offtake",
        total(rows, "secondaryCentavos"),
        "php",
        null,
        total(prior, "secondaryCentavos"),
        "Distributor retailer invoice-line value, attributed to exact outlet.",
      ),
      kpi(
        "tradeStock",
        "Trade stock",
        total(rows, "stockCases"),
        "cases",
        null,
        total(prior, "stockCases"),
        "Latest declared stock per distributor/SKU in the selected period; not SAP inventory valuation.",
      ),
    ],
    rows: rows.map((r) => {
      const before = prior.find((b) => b.key === r.key);
      return {
        ...r,
        priorPrimaryCentavos: before?.primaryCentavos ?? null,
        priorSecondaryCentavos: before?.secondaryCentavos ?? null,
        secondaryContributionPct: pct(
          r.secondaryCentavos,
          total(rows, "secondaryCentavos"),
        ),
        primaryContributionPct: pct(
          r.primaryCentavos,
          total(rows, "primaryCentavos"),
        ),
      };
    }),
    contributions: tradeContributions(facts),
    trend,
  };
}

/** F-603 channel/account contribution uses source invoice grain, never a stock join.
 * @param {any[]} facts */
function tradeContributions(facts) {
  const rows = [];
  for (const dimension of ["channel", "account_name"]) {
    const groups = new Map();
    for (const f of facts.filter((f) =>
      ["primary", "secondary"].includes(f.kind),
    )) {
      const label = f[dimension] ?? "Unassigned",
        key = `${dimension}:${f.kind}:${label}`;
      if (!groups.has(key))
        groups.set(key, {
          key,
          dimension: dimension === "channel" ? "Channel" : "Account",
          label,
          kind: f.kind,
          valueCentavos: 0,
          known: true,
          sourceLines: 0,
        });
      const g = groups.get(key);
      g.valueCentavos += Number(f.amount_centavos ?? 0);
      g.known &&= f.amount_centavos !== null;
      g.sourceLines++;
    }
    rows.push(
      ...[...groups.values()].map((g) => ({
        ...g,
        valueCentavos: g.known ? g.valueCentavos : null,
      })),
    );
  }
  return rows;
}
/** F-607 auditable planning feed. Promotion plans stay explicit, not an invented uplift forecast.
 * @param {any} ctx @param {any} p @param {any} s */
export async function demandSignalPage(ctx, p, s) {
  const [facts, av] = await Promise.all([
    readTradeInputs(ctx.db, p, s),
    availabilityModel(ctx.db, p, s),
  ]);
  const trade = tradeRows(facts, p.days);
  const rows = trade.map((r) => ({
    ...r,
    numericDistributionPct:
      av.distribution.find(
        (/** @type {any} */ d) => d.productId === r.productId,
      )?.numericDistributionPct ?? null,
    promotionPlans: facts
      .filter(
        (/** @type {any} */ f) =>
          f.kind === "promotion_plan" &&
          f.product_id === r.productId &&
          f.distributor_key === r.distributorKey,
      )
      .map((/** @type {any} */ f) => ({
        campaign: f.campaign_ref,
        plannedBase: Number(f.quantity_base),
        sourceId: f.id,
      })),
    completeness:
      r.stockBase === null
        ? "Missing trade stock"
        : av.setupRequired
          ? "Availability policy needs setup"
          : "Source coverage shown; not a forecast",
  }));
  return {
    definitionVersion: "commercial/v1",
    cutoffAt: ctx.now,
    demo: facts.some((/** @type {any} */ f) => f.source_type === "sample"),
    rows,
    lineage: rows.flatMap((r) => r.lineage),
    completeness: {
      secondary: facts.some((/** @type {any} */ f) => f.kind === "secondary"),
      tradeStock: facts.some((/** @type {any} */ f) => f.kind === "stock"),
      distribution:
        av.distribution.length > 0 &&
        av.distribution.every(
          (/** @type {any} */ d) => d.numericDistributionPct !== null,
        ),
      promotionPlans: facts.some(
        (/** @type {any} */ f) => f.kind === "promotion_plan",
      ),
    },
    notice:
      "Planning input only. Supply Chain must acknowledge this version; sample facts are not a production forecast.",
  };
}
/** @param {any} router @param {any} installCtx */
export function installPlanning(router, installCtx) {
  router.post(
    "/api/v1/planning/demand-signals/prepare",
    async (/** @type {any} */ ctx) =>
      tx(ctx.db, async (db) => {
        await requireCapability({ ...ctx, db }, "target.manage");
        const b = inputObject(ctx.body);
        const local = { ...ctx, db, url: new URL(ctx.req.url) };
        for (const k of ["from", "to", "unitId", "channel"])
          if (b[k]) local.url.searchParams.set(k, b[k]);
        const s = await scopeFor(local),
          p = periodFor(local),
          key = b.requestKey;
        if (typeof key !== "string" || !key.length || key.length > 120)
          throw new ApiError(
            "invalid_request",
            400,
            "Provide a planning request key.",
          );
        const hash = sha256Hex(
          JSON.stringify([p.from, p.to, p.channel, s.unitId, s.ids]),
        );
        await db`select pg_advisory_xact_lock(hashtext(${ctx.actor.profileId + key}))`;
        const [existing] =
          await db`select * from demand_signal_snapshots where created_by=${ctx.actor.profileId} and request_key=${key}`;
        if (existing) {
          if (existing.request_hash !== hash)
            throw new ApiError(
              "idempotency_conflict",
              409,
              "This request key belongs to a different planning cut.",
            );
          return {
            id: existing.id,
            status: existing.status,
            contentHash: existing.content_hash,
            duplicate: true,
          };
        }
        const payload = await demandSignalPage(local, p, s),
          content = sha256Hex(JSON.stringify(payload));
        const [r] =
          await db`insert into demand_signal_snapshots(org_unit_id,created_by,period_from,period_to,cutoff_at,definition_version,request_key,request_hash,content_hash,payload,status) values(${s.unitId},${ctx.actor.profileId},${p.from},${p.to},${new Date(ctx.now)},'commercial/v1',${key},${hash},${content},${payload},'prepared') returning id`;
        await db`insert into audit_logs(subject,action,entity_type,entity_id) values(${ctx.actor.subject},'planning.prepared','demand_signal',${r.id})`;
        return {
          id: r.id,
          status: "prepared",
          contentHash: content,
          duplicate: false,
        };
      }),
  );
  router.post(
    "/api/v1/planning/demand-signals/transition",
    async (/** @type {any} */ ctx) =>
      tx(ctx.db, async (db) => {
        await requireCapability({ ...ctx, db }, "target.manage");
        const s = await scopeFor({ ...ctx, db }),
          b = inputObject(ctx.body);
        const [row] =
          await db`select * from demand_signal_snapshots where id=${uuidInput(b.id)} for update`;
        if (!row || (row.org_unit_id && !s.ids.includes(row.org_unit_id)))
          throw new ApiError(
            "out_of_scope",
            403,
            "This planning cut is outside your team.",
          );
        // Re-check every source line against current authorization before publication/ack.
        await authorizedSnapshot(db, row, s);
        if (b.action === "publish" && row.status === "prepared") {
          if (
            typeof b.destination !== "string" ||
            !b.destination.trim() ||
            b.destination.length > 200
          )
            throw new ApiError(
              "invalid_destination",
              400,
              "Name the planning destination.",
            );
          await db`update demand_signal_snapshots set status='published',destination=${b.destination},published_at=now(),updated_at=now() where id=${row.id}`;
        } else if (
          ["accept", "reject"].includes(b.action) &&
          row.status === "published"
        ) {
          if (row.created_by === ctx.actor.profileId)
            throw new ApiError(
              "self_approval",
              403,
              "A different planning owner must acknowledge this cut.",
            );
          if (
            typeof b.reference !== "string" ||
            !b.reference.trim() ||
            b.reference.length > 200
          )
            throw new ApiError(
              "invalid_ack",
              400,
              "Provide the handoff acknowledgement reference.",
            );
          await db`update demand_signal_snapshots set status=${b.action === "accept" ? "accepted" : "rejected"},acknowledged_at=now(),acknowledged_by=${ctx.actor.profileId},acknowledgement=${b.reference},updated_at=now() where id=${row.id}`;
        } else
          throw new ApiError(
            "invalid_transition",
            409,
            "This planning cut cannot make that transition.",
          );
        await db`insert into audit_logs(subject,action,entity_type,entity_id) values(${ctx.actor.subject},${"planning." + b.action},'demand_signal',${row.id})`;
        return { ok: true };
      }),
  );
  router.get(
    "/api/v1/planning/demand-signals",
    async (/** @type {any} */ ctx) => {
      const s = await scopeFor(ctx);
      const candidates =
        await ctx.db`select * from demand_signal_snapshots where org_unit_id in ${ctx.db(s.ids.length ? s.ids : [null])} order by created_at desc limit 100`;
      const rows = [];
      for (const row of candidates) {
        try {
          await authorizedSnapshot(ctx.db, row, s);
          rows.push({
            id: row.id,
            label: `${dateOf(row.period_from)} – ${dateOf(row.period_to)} · ${row.status}`,
            status: row.status,
          });
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 403) throw error;
        }
      }
      return { rows };
    },
  );
  router.get(
    "/api/v1/planning/demand-signals/snapshot",
    async (/** @type {any} */ ctx) => {
      const s = await scopeFor(ctx),
        [row] =
          await ctx.db`select * from demand_signal_snapshots where id=${uuidInput(ctx.url.searchParams.get("id"))}`;
      if (!row || (row.org_unit_id && !s.ids.includes(row.org_unit_id)))
        throw new ApiError(
          "out_of_scope",
          403,
          "This planning cut is outside your team.",
        );
      await authorizedSnapshot(ctx.db, row, s);
      if (ctx.url.searchParams.get("format") === "xlsx")
        return xlsx(
          { ...row.payload, status: row.status, contentHash: row.content_hash },
          "demand-signal-cut",
        );
      return {
        id: row.id,
        status: row.status,
        contentHash: row.content_hash,
        destination: row.destination,
        payload: row.payload,
      };
    },
  );
}
/** @param {any} db @param {any} row @param {any} s */
async function authorizedSnapshot(db, row, s) {
  const sourceIds = row.payload.lineage.map((/** @type {any} */ r) => r.id);
  const authorized = await readTradeInputs(
    db,
    { from: dateOf(row.period_from), to: dateOf(row.period_to), channel: null },
    s,
  );
  const ids = new Set(authorized.map((/** @type {any} */ r) => r.id));
  if (sourceIds.some((/** @type {string} */ id) => !ids.has(id)))
    throw new ApiError(
      "scope_changed",
      403,
      "Source access changed. Prepare a new planning cut.",
    );
}
