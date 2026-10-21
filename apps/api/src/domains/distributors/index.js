import { tx } from "@sunpride/db/client";
import { nextDayClose } from "../../core/scope.js";
import { actorFor } from "../../core/context.js";
import { requireCapability } from "../../core/capabilities.js";
import { scopeFilterForActor } from "../org/scope.js";
import {
  authorize,
  command,
  fail,
  master,
  policy,
  read,
  text,
  today,
  uuid,
  wire,
} from "./model.js";
import {
  acceptAgreement,
  apply,
  createDistributor,
  invite,
  reviewApplication,
  revoke,
  setLocation,
  setPolicy,
  syncFinancial,
  syncMaster,
} from "./setup.js";
import { placeOrder, quote } from "./ordering.js";
import { saveVanArrangement } from "./van-arrangement.js";
import {
  declareStock,
  processSecondary,
  setMap,
  stageSecondary,
  SECONDARY_HEADERS,
} from "./capture.js";
import {
  acknowledgeDocument,
  disputeRemittance,
  matchRemittance,
  remit,
  reviewClaim,
  submitClaim,
  uploadDocument,
} from "./finance.js";
import {
  reconciliation,
  recordAudit,
  reviewReconciliation,
  scorecard,
  stockHealth,
} from "./analytics.js";
import {
  distributorCallflowConfig,
  distributorVanContext,
  sapCreditCheck,
} from "./seams.js";

/** @param {any} c */
async function partners(c) {
  if (!c.actor) fail("Sign in to continue", "unauthenticated", 401);
  if (c.actor.role === "distributor")
    return {
      rows: await c.db`select d.id,d.code,d.name,d.status,d.source,u.grants from distributors d join distributor_users u on u.distributor_id=d.id where u.profile_id=${c.actor.profileId} and d.device_org_unit_id=${c.actor.orgUnitId} and u.effective_from<=now() and (u.effective_to is null or u.effective_to>now()) and d.effective_from<=now() and (d.effective_to is null or d.effective_to>now()) and d.status not in ('suspended','rejected') order by d.name`,
      next: null,
    };
  await requireCapability(c, "integration.read");
  const { unitIds } = await scopeFilterForActor(c.db, c.actor);
  const after = c.url.searchParams.get("after") ?? "";
  const rows =
    await c.db`select id,code,name,status,source from distributors where (${unitIds === null} or org_unit_id::text in (select jsonb_array_elements_text(${JSON.stringify(unitIds ?? [])}::text::jsonb))) and code>${after} order by code limit 201`;
  return {
    rows: rows.slice(0, 200),
    next: rows.length > 200 ? rows[199].code : null,
  };
}
/** @param {any} c @param {any} d */
async function workspace(c, d) {
  const m = await master(c, d.id),
    p = await policy(c, d.id);
  const [app] =
    await c.db`select id,legal_name,stage,agreement_document_id,agreement_hash,created_at from distributor_applications where distributor_id=${d.id}`;
  const outlets =
    await c.db`select o.id,o.code,o.name,g.territory_id,t.name as territory from distributor_outlets g join outlets o on o.id=g.outlet_id left join territories t on t.id=g.territory_id where g.distributor_id=${d.id} and g.effective_from<=now() and (g.effective_to is null or g.effective_to>now()) and o.deleted_at is null order by o.code`;
  const catalog = [];
  for (const entry of m.payload.products) {
    const [product] =
      await c.db`select code,name from products where id=${entry.productId} and active and deleted_at is null`;
    if (product) catalog.push({ ...entry, ...product });
  }
  const locations =
    await c.db`select id,code,name,kind from distributor_locations where distributor_id=${d.id} and effective_from<=now() and (effective_to is null or effective_to>now()) order by code`;
  const docs =
    await c.db`select d.id,d.kind,d.title,d.version,d.sha256,d.published,d.created_at,exists(select 1 from distributor_document_reads r where r.document_id=d.id and r.profile_id=${c.actor.profileId}) as read from distributor_documents d where d.distributor_id=${d.id} and (d.published or d.uploaded_by=${c.actor.profileId} or ${c.actor.role !== "distributor"}) order by d.created_at desc,d.id desc limit 201`;
  const users =
    c.actor.role !== "distributor"
      ? await c.db`select u.id,u.profile_id,p.name,p.email,u.grants,u.effective_to from distributor_users u join profiles p on p.id=u.profile_id where u.distributor_id=${d.id} order by u.created_at desc limit 201`
      : [];
  return {
    distributor: {
      id: d.id,
      code: d.code,
      name: d.name,
      status: d.status,
      source: d.source,
      sapCustomerCode: d.sap_customer_code,
    },
    application: app ?? null,
    terms: m.payload.terms,
    catalog,
    outlets,
    locations,
    documents: docs.slice(0, 200),
    documentsTruncated: docs.length > 200,
    users: users.slice(0, 200),
    usersTruncated: users.length > 200,
    policy: p,
    masterVersion: Number(m.version),
    masterReceivedAt: m.received_at,
  };
}
/** CSV built only from the exact authorized response. @param {any[]} rows @param {string[]} columns */
function csv(rows, columns) {
  const cell = (/** @type {any} */ v) => {
    let s =
      v === null || v === undefined
        ? ""
        : typeof v === "object"
          ? JSON.stringify(v)
          : String(v);
    if (/^[\s]*[=+@-]/.test(s)) s = "'" + s;
    return `"${s.replaceAll('"', '""')}"`;
  };
  return new Response(
    "\uFEFF" +
      [columns, ...rows.map((r) => columns.map((k) => r[k]))]
        .map((row) => row.map(cell).join(","))
        .join("\r\n"),
    {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "cache-control": "private, no-store",
        "content-disposition": "attachment; filename=distributor-export.csv",
      },
    },
  );
}
/** @param {import('../../core/router.js').Router} router @param {any} platform */
export function install(router, platform) {
  router.get("/api/v1/distributors", (c) => read(c, partners));
  router.post("/api/v1/distributors/create", createDistributor);
  router.get("/api/v1/distributors/setup", (c) =>
    read(c, async (cc) => {
      const d = await authorize(
        cc,
        uuid(c.url.searchParams.get("distributorId")),
        "read",
        true,
      );
      const [m] =
        await cc.db`select id,version,payload,source,source_key,effective_from,received_at from distributor_master_versions where distributor_id=${d.id} and effective_to is null order by version desc limit 1`;
      const [p] =
        await cc.db`select settings,version from distributor_policies where distributor_id=${d.id} and effective_to is null`;
      const users =
        await cc.db`select u.id,p.name,p.email,u.grants,u.effective_to from distributor_users u join profiles p on p.id=u.profile_id where u.distributor_id=${d.id} order by u.created_at desc limit 201`;
      return {
        distributor: d,
        master: m ?? null,
        policy: p ?? null,
        users: users.slice(0, 200),
        usersTruncated: users.length > 200,
      };
    }),
  );
  /** @param {string} path @param {string} grant @param {(c:any,d:any,b:any)=>Promise<any>} fn @param {boolean} [office] */
  const post = (path, grant, fn, office = false) =>
    router.post(`/api/v1/distributors/${path}`, (c) =>
      command(c, `F-4.${path}`, grant, fn, office),
    );
  /** @param {string} path @param {string} grant @param {(c:any,d:any)=>Promise<any>} fn @param {string[]} [columns] */
  const get = (path, grant, fn, columns) =>
    router.get(`/api/v1/distributors/${path}`, async (c) => {
      const value = await read(c, async (cc) => {
        const d = await authorize(
          cc,
          uuid(c.url.searchParams.get("distributorId")),
          grant,
        );
        return fn(cc, d);
      });
      if (c.url.searchParams.get("format") === "csv") {
        if (!columns || value.next)
          fail("Narrow or finish paging before export", "incomplete_export");
        return csv(value.rows ?? [], columns);
      }
      return value;
    });
  post("invite", "read", invite, true);
  post("revoke", "read", revoke, true);
  post("master/sync", "read", syncMaster, true);
  post("financial/sync", "finance", syncFinancial, true);
  post("policy", "read", setPolicy, true);
  post("location", "stock", setLocation, true);
  post("apply", "read", apply);
  post("application/review", "read", reviewApplication, true);
  post("agreement/accept", "documents", acceptAgreement);
  get("workspace", "read", workspace);
  post("quote", "order", quote);
  post("orders", "order", placeOrder);
  get(
    "orders",
    "order",
    async (c, d) => {
      const after = c.url.searchParams.get("after");
      if (after) uuid(after);
      const rows =
        await c.db`select id,order_number,customer_po_number,status,total_centavos,acknowledged_at,promised_delivery_date,created_at from orders where purchasing_distributor_id=${d.id} and deleted_at is null and (${after ?? null}::uuid is null or id>${after ?? null}::uuid) order by id limit 201`;
      return {
        rows: rows.slice(0, 200),
        next: rows.length > 200 ? rows[199].id : null,
      };
    },
    [
      "order_number",
      "customer_po_number",
      "status",
      "total_centavos",
      "promised_delivery_date",
    ],
  );
  get("credit", "finance", sapCreditCheck);
  post("stock", "stock", declareStock);
  get("stock-health", "stock", stockHealth, [
    "code",
    "name",
    "onHandBase",
    "daysOfInventory",
    "nearExpiryBase",
    "status",
  ]);
  post("maps", "secondary", setMap);
  post("secondary/stage", "secondary", stageSecondary);
  post("secondary/process", "secondary", processSecondary);
  get(
    "secondary",
    "secondary",
    async (c, d) => {
      const runs =
        await c.db`select r.id,r.source_key,r.adapter,r.created_at,count(s.id)::integer as lines,count(s.id) filter(where s.status='mapping')::integer as mapping,count(s.id) filter(where s.status='rejected')::integer as rejected,count(s.id) filter(where s.status in ('posted','duplicate'))::integer as posted from distributor_ingest_runs r left join distributor_staging_lines s on s.run_id=r.id where r.distributor_id=${d.id} group by r.id order by r.created_at desc limit 201`;
      const after = c.url.searchParams.get("after");
      if (after) uuid(after);
      const rows =
        await c.db`select f.*,o.name as outlet_name,p.name as product_name from distributor_secondary_current f join outlets o on o.id=f.outlet_id join products p on p.id=f.product_id where f.distributor_id=${d.id} and (${after ?? null}::uuid is null or f.id>${after ?? null}::uuid) order by f.id limit 201`;
      const queue =
        await c.db`select s.id,s.run_id,s.ordinal,s.raw,s.status,s.reason from distributor_staging_lines s join distributor_ingest_runs r on r.id=s.run_id where r.distributor_id=${d.id} and s.status not in ('posted','duplicate') order by r.created_at desc,s.ordinal limit 201`;
      const maps =
        await c.db`select * from distributor_code_maps where distributor_id=${d.id} and effective_from<=now() and (effective_to is null or effective_to>now()) order by kind,external_code limit 501`;
      return {
        rows: rows.slice(0, 200),
        next: rows.length > 200 ? rows[199].id : null,
        runs: runs.slice(0, 200),
        runsTruncated: runs.length > 200,
        queue: queue.slice(0, 200),
        queueTruncated: queue.length > 200,
        maps: maps.slice(0, 500),
        mapsTruncated: maps.length > 500,
        templateHeaders: SECONDARY_HEADERS,
      };
    },
    [
      "invoice_number",
      "line_key",
      "revision",
      "sale_date",
      "kind",
      "outlet_name",
      "product_name",
      "quantity_base",
      "amount_centavos",
    ],
  );
  post("documents", "documents", uploadDocument);
  post("documents/read", "documents", acknowledgeDocument);
  get("documents", "documents", async (c, d) => ({
    rows: (await workspace(c, d)).documents,
    receipts:
      c.actor.role !== "distributor"
        ? await c.db`select r.document_id,p.name,r.created_at from distributor_document_reads r join distributor_documents doc on doc.id=r.document_id join profiles p on p.id=r.profile_id where doc.distributor_id=${d.id} order by r.created_at desc limit 501`
        : [],
  }));
  router.get("/api/v1/distributors/documents/:id", async (c) => {
    const result = await read(c, async (cc) => {
      const d = await authorize(
        cc,
        uuid(c.url.searchParams.get("distributorId")),
        "documents",
      );
      const [doc] =
        await cc.db`select * from distributor_documents where id=${uuid(c.params.id)} and distributor_id=${d.id} and (published or uploaded_by=${cc.actor.profileId} or ${cc.actor.role !== "distributor"})`;
      if (!doc) fail("Document outside your audience", "out_of_scope", 403);
      return {
        mime: doc.mime,
        base64: Buffer.from(doc.content).toString("base64"),
      };
    });
    return new Response(Buffer.from(result.base64, "base64"), {
      headers: {
        "content-type": result.mime,
        "content-disposition": "attachment; filename=partner-document",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  });
  post("claims", "claim", submitClaim);
  post("claims/review", "claim", reviewClaim, true);
  get("claims", "claim", async (c, d) => ({
    rows: await c.db`select i.*,q.id as shared_claim_id,case when q.status in ('validated','approved','part_settled','settled','needs_evidence','rejected') then q.status else i.status end as status from distributor_claims i left join claims q on q.id=i.id where i.distributor_id=${d.id} order by i.created_at desc limit 200`,
    notifications:
      await c.db`select id,claim_id,message,created_at from claim_notifications where party_type='distributor' and party_id=${d.id} order by created_at desc limit 200`,
  }));
  post("remittances", "finance", remit);
  post("remittances/dispute", "finance", disputeRemittance);
  post("remittances/match", "finance", matchRemittance, true);
  get("finance", "finance", async (c, d) => ({
    credit: await sapCreditCheck(c, d),
    items:
      await c.db`select * from distributor_ar_items where distributor_id=${d.id} order by due_date,id`,
    remittances:
      await c.db`select * from distributor_remittances where distributor_id=${d.id} order by created_at desc`,
    sapRequests:
      await c.db`select id,kind,status,acknowledgement,created_at from distributor_sap_requests where distributor_id=${d.id} order by created_at desc limit 200`,
  }));
  get(
    "reconciliation",
    "read",
    (c, d) => reconciliation(c, d, Object.fromEntries(c.url.searchParams)),
    [
      "code",
      "name",
      "openingBase",
      "primaryBase",
      "secondaryBase",
      "closingBase",
      "varianceBase",
      "status",
    ],
  );
  post("reconciliation/review", "read", reviewReconciliation);
  get("scorecard", "read", scorecard);
  post("audit", "read", recordAudit, true);
  get("callflow-config", "dsr", distributorCallflowConfig);
  get("van-context", "settlement", distributorVanContext);
  post("van-arrangements/save", "settlement", saveVanArrangement, true);
  platform.registerTopic(
    "distributor",
    async (/** @type {any} */ actor, /** @type {string} */ topic) => {
      const id = topic.split(":")[1];
      if (!id || topic !== `distributor:${id}`) return false;
      try {
        await authorize({ db: platform.db, actor }, id);
        return true;
      } catch {
        return false;
      }
    },
  );
  platform.registerProjection("distributor.bundle", {
    leaseExpiresAt: (/** @type {any} */ c) => c.partnerLeaseExpiresAt ?? c.now,
    snapshot: async (/** @type {any} */ c) =>
      read(c, async (cc) => {
        if (
          cc.actor?.scopeEpoch !== c.actor.scopeEpoch ||
          cc.actor?.orgUnitId !== c.actor.orgUnitId
        )
          fail("Partner scope changed", "scope_changed", 409);
        const d = await authorize(cc, uuid(c.params?.distributorId), "dsr");
        if (d.status !== "accredited")
          fail("Distributor is not accredited", "out_of_scope", 403);
        const config = await distributorCallflowConfig(cc, d),
          m = await master(cc, d.id);
        c.partnerLeaseExpiresAt = Math.min(
          nextDayClose(c.now),
          config.validUntil ? new Date(config.validUntil).getTime() : Infinity,
          d.effective_to ? new Date(d.effective_to).getTime() : Infinity,
        );
        return {
          data: wire({
            configuration: config,
            catalog: m.payload.products,
            masterVersion: Number(m.version),
          }),
          next: null,
        };
      }),
    // CORE calls scopeKeys on EVERY delta, including an empty one. Never renew a
    // held/revoked partner's authorization merely because no change row exists.
    scopeKeys: async (/** @type {any} */ c) => {
      const d = await authorize(c, uuid(c.params?.distributorId), "dsr");
      if (d.status !== "accredited")
        fail("Distributor is not accredited", "out_of_scope", 403);
      fail(
        "Refresh the complete partner configuration; shared call-flow deltas are not integrated yet",
        "rebootstrap_required",
        409,
      );
    },
  });
}
