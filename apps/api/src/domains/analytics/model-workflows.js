import { tx } from "@sunpride/db/client";
import { resolve, sep } from "node:path";
import { actorFor } from "../../core/context.js";
import { requireCapability } from "../../core/capabilities.js";
import { filesDir } from "../../core/media.js";
import { canonicalJson, sha256Hex } from "../../core/util.js";
import { accessOutlet, accessVisit } from "../visits/shared.js";
import { uuid, text, choice, fail } from "../orders/validation.js";
import { scopeFor } from "./measures.js";
import { orderFeatures, trainOrderModel, predictOrder } from "./order-model.js";
import { inferShelf, shelfFacts } from "./shelf-model.js";

/** @param {any} c @param {any} row */
async function sourceAccess(c, row) {
  await requireCapability(c, "report.read", row.org_unit_id);
  if (row.outlet_id) await accessOutlet(c, row.outlet_id, "report.read");
  if (row.retain_until && +new Date(row.retain_until) <= c.now)
    fail("Source retention expired");
}
/** @param {any} c @param {string} id */
async function dataset(c, id) {
  const [row] =
    await c.db`select * from analytics_ai_dataset_items where id=${uuid(id)}`;
  if (!row) fail("Dataset item not found");
  await sourceAccess(c, row);
  return row;
}
/** @param {any} c @param {string} id */
async function model(c, id) {
  const [row] =
    await c.db`select * from analytics_model_versions where id=${uuid(id)}`;
  if (!row) fail("Model not found");
  await sourceAccess(c, row);
  if (row.configuration.outletId)
    await accessOutlet(c, row.configuration.outletId, "report.read");
  for (const item of row.configuration.datasetIds ?? []) await dataset(c, item);
  return row;
}
/** Read the original authorized field image; never accept a caller-supplied file path or URL.
 * @param {any} c @param {any} item */
async function shelfImage(c, item) {
  const [photo] =
    await c.db`select e.*,f.path,f.size,f.sha256 from field_evidence_files e join files f on f.id=e.storage_id where e.id=${uuid(item.source_reference)} and e.outlet_id=${item.outlet_id} and e.deleted_at is null and e.status<>'rejected' and f.status='stored' and f.stored_at is not null and f.sha256=e.checksum`;
  if (!photo) fail("Original photo is unavailable");
  const [visit] =
    await c.db`select * from visit_executions where id=${photo.visit_id}`;
  await accessVisit(c, visit);
  const root = resolve(filesDir(c.env)),
    path = resolve(root, photo.path);
  if (!path.startsWith(root + sep) || Number(photo.size) > 10 * 1024 * 1024)
    fail("Photo is unavailable");
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  if (bytes.length !== Number(photo.size) || sha256Hex(bytes) !== photo.sha256)
    fail("Photo integrity check failed");
  return bytes;
}
/** @param {any} c @param {any} b */
export async function addDataset(c, b) {
  const { owner } = await accessOutlet(
    c,
    uuid(b.outletId),
    "masterdata.manage",
  );
  const purpose = choice(
    b.purpose,
    ["shelf_ground_truth", "order_backtest"],
    "Dataset purpose",
  );
  const observed = new Date(b.observedAt),
    retain = new Date(b.retainUntil);
  if (
    !Number.isFinite(+observed) ||
    +observed > c.now ||
    !Number.isFinite(+retain) ||
    +retain <= c.now
  )
    fail("Choose a past observation and future retention end");
  if (
    !b.annotations ||
    typeof b.annotations !== "object" ||
    Array.isArray(b.annotations)
  )
    fail("Supply reviewed annotations");
  if (purpose === "order_backtest") {
    orderFeatures(b.annotations);
    if (
      !Number.isSafeInteger(b.annotations.nextOrderBase) ||
      b.annotations.nextOrderBase < 0
    )
      fail("Supply actual next-order base units");
  } else
    shelfFacts(b.annotations.detections ?? [], {
      expectedFacings: b.annotations.expectedFacings ?? {},
    });
  const source = text(b.sourceReference, "Source reference", 300),
    consent = text(b.consentReference, "Consent/source permission", 300);
  if (purpose === "shelf_ground_truth")
    await shelfImage(c, { source_reference: source, outlet_id: b.outletId });
  const [row] =
    await c.db`insert into analytics_ai_dataset_items(purpose,org_unit_id,outlet_id,product_id,source_reference,observed_at,consent_reference,retain_until,annotations,split,source_type) values(${purpose},${owner},${b.outletId},${b.productId ? uuid(b.productId) : null},${source},${observed},${consent},${retain},${b.annotations},${choice(b.split, ["train", "validation", "temporal_holdout"], "Split")},${choice(b.sourceType ?? "sample", ["sample", "real"], "Source")}) returning id`;
  return { id: row.id };
}
/** @param {any} c @param {any} b */
export async function trainModel(c, b) {
  if (
    !Array.isArray(b.datasetIds) ||
    !b.datasetIds.length ||
    b.datasetIds.length > 2000 ||
    new Set(b.datasetIds).size !== b.datasetIds.length
  )
    fail("Choose distinct retained dataset items");
  const rows = [];
  for (const id of b.datasetIds) rows.push(await dataset(c, id));
  const purpose = choice(
      b.purpose,
      ["shelf", "suggested_order"],
      "Model purpose",
    ),
    first = rows[0];
  if (
    rows.some(
      (r) =>
        r.org_unit_id !== first.org_unit_id ||
        r.outlet_id !== first.outlet_id ||
        r.product_id !== first.product_id ||
        r.purpose !==
          (purpose === "shelf" ? "shelf_ground_truth" : "order_backtest"),
    )
  )
    fail("A version must use one scoped outlet/product dataset");
  const configuration = {
    datasetIds: b.datasetIds,
    outletId: first.outlet_id,
    productId: first.product_id,
    ...(purpose === "shelf"
      ? {
          adapterVersion: text(
            b.adapterVersion,
            "Pinned model artifact version",
            120,
          ),
          minimumConfidence: 0.8,
          expectedFacings: first.annotations.expectedFacings ?? {},
          expectedSlots: first.annotations.expectedSlots ?? [],
        }
      : {}),
  };
  const fitted =
    purpose === "suggested_order"
      ? trainOrderModel(rows)
      : {
          artifact: { adapter: "configured-local-command" },
          metrics: {
            reviewedImages: rows.length,
            accuracy: null,
            approvalNote:
              "Representative image accuracy has not been certified",
          },
        };
  const hash = sha256Hex(canonicalJson({ rows, configuration }));
  await c.db`select pg_advisory_xact_lock(hashtextextended(${first.org_unit_id + purpose},0))`;
  const [old] =
    await c.db`select id from analytics_model_versions where org_unit_id=${first.org_unit_id} and purpose=${purpose} and source_hash=${hash}`;
  if (old) return old;
  const [latest] =
    await c.db`select coalesce(max(version),0)+1 as version from analytics_model_versions where org_unit_id=${first.org_unit_id} and purpose=${purpose}`;
  const [row] =
    await c.db`insert into analytics_model_versions(purpose,version,org_unit_id,algorithm,configuration,artifact,metrics,source_hash,status,sample,created_by) values(${purpose},${latest.version},${first.org_unit_id},${purpose === "shelf" ? "pinned-local-detector" : "ridge-base-units/v1"},${configuration},${fitted.artifact},${fitted.metrics},${hash},'candidate',${rows.some((r) => r.source_type === "sample")},${c.actor.subject}) returning id`;
  return row;
}
/** @param {any} c @param {any} b */
export async function predictModel(c, b) {
  const m = await model(c, b.modelId),
    item = await dataset(c, b.datasetId);
  if (
    m.status !== "approved" ||
    item.outlet_id !== m.configuration.outletId ||
    item.product_id !== m.configuration.productId
  )
    fail("Use an approved model matching the source outlet/product");
  const key = text(b.idempotencyKey, "Request key", 160),
    hash = sha256Hex(canonicalJson({ model: m.id, item }));
  await c.db`select pg_advisory_xact_lock(hashtextextended(${c.actor.subject + ":ai:" + key},0))`;
  const [prior] =
    await c.db`select * from analytics_model_runs where created_by=${c.actor.subject} and request_key=${key}`;
  if (prior) {
    if (prior.source_hash !== hash) fail("Request key content changed");
    return prior;
  }
  const result =
    m.purpose === "shelf"
      ? await inferShelf(await shelfImage(c, item), m.configuration, c.env)
      : {
          available: true,
          quantityBase: predictOrder(m.artifact, item.annotations),
          ruleQuantityBase: Math.max(
            0,
            Math.ceil(
              item.annotations.historyDailyBase *
                (1 + item.annotations.promotionUpliftPct / 100) *
                item.annotations.coverDays -
                item.annotations.stockBase,
            ),
          ),
          requiresReview: true,
        };
  const [row] =
    await c.db`insert into analytics_model_runs(model_id,org_unit_id,outlet_id,purpose,source_reference,request_key,source_hash,input,result,status,created_by) values(${m.id},${item.org_unit_id},${item.outlet_id},${m.purpose},${item.id},${key},${hash},${{ datasetId: item.id, sample: m.sample || item.source_type === "sample" }},${result},${result.available ? "predicted" : "unavailable"},${c.actor.subject}) returning *`;
  return row;
}
/** @param {any} router @param {any} installCtx */
export function installModels(router, installCtx) {
  router.get("/api/v1/analytics/models", async (/** @type {any} */ c) => {
    const s = await scopeFor(c);
    const candidates =
      await c.db`select * from analytics_model_versions where org_unit_id in ${c.db(s.ids.length ? s.ids : [null])} order by created_at desc limit 101`;
    const models = [];
    for (const row of candidates) {
      try {
        await model(c, row.id);
        models.push(row);
      } catch (e) {
        if (!(
          e &&
          typeof e === "object" &&
          "status" in e &&
          [403, 422].includes(Number(e.status))
        ))
          throw e;
      }
    }
    const items =
      await c.db`select id,purpose,org_unit_id,outlet_id,product_id,source_reference,observed_at,retain_until,split,source_type from analytics_ai_dataset_items where org_unit_id in ${c.db(s.ids.length ? s.ids : [null])} and retain_until>now() order by created_at desc limit 101`;
    const datasets = [];
    for (const item of items) {
      try {
        await sourceAccess(c, item);
        datasets.push(item);
      } catch (e) {
        if (!(
          e &&
          typeof e === "object" &&
          "status" in e &&
          Number(e.status) === 403
        ))
          throw e;
      }
    }
    const raw =
      await c.db`select * from analytics_model_runs where org_unit_id in ${c.db(s.ids.length ? s.ids : [null])} order by created_at desc limit 101`;
    const runs = [];
    for (const row of raw) {
      try {
        await sourceAccess(c, row);
        await dataset(c, row.source_reference);
        await model(c, row.model_id);
        row.reviews =
          await c.db`select decision,correction,reason,created_at from analytics_model_reviews where run_id=${row.id} order by created_at desc,id desc limit 100`;
        runs.push(row);
      } catch (e) {
        if (!(
          e &&
          typeof e === "object" &&
          "status" in e &&
          [403, 422].includes(Number(e.status))
        ))
          throw e;
      }
    }
    const outlets =
      await c.db`select id,name,code from analytics_store_scope where owner_unit_id in ${c.db(s.ids.length ? s.ids : [null])} order by name limit 501`;
    const products =
      await c.db`select id,name,code from products where active and deleted_at is null order by name limit 501`;
    return {
      outlets: outlets.slice(0, 500),
      products: products.slice(0, 500),
      models: models.slice(0, 100),
      datasets: datasets.slice(0, 100),
      runs: runs.slice(0, 100),
      truncated:
        candidates.length > 100 || items.length > 100 || raw.length > 100,
    };
  });
  const handlers = {
    dataset: addDataset,
    train: trainModel,
    predict: predictModel,
    approve: async (/** @type {any} */ c, /** @type {any} */ b) => {
      const m = await model(c, b.modelId);
      if (m.created_by === c.actor.subject)
        fail("A different authorized reviewer must approve the model");
      if (m.status !== "candidate")
        fail("Only candidate versions can be approved");
      if (m.purpose === "suggested_order" && !m.metrics.improvesBaseline)
        fail("Keep the existing rule until held-out error improves");
      await c.db`update analytics_model_versions set status='retired',updated_at=now() where purpose=${m.purpose} and org_unit_id=${m.org_unit_id} and configuration->>'outletId'=${m.configuration.outletId} and configuration->>'productId' is not distinct from ${m.configuration.productId} and status='approved'`;
      await c.db`update analytics_model_versions set status='approved',approved_by=${c.actor.subject},updated_at=now() where id=${m.id}`;
      return { id: m.id };
    },
    review: async (/** @type {any} */ c, /** @type {any} */ b) => {
      const [run] =
        await c.db`select * from analytics_model_runs where id=${uuid(b.runId)} for update`;
      if (!run) fail("Run not found");
      await sourceAccess(c, run);
      await dataset(c, run.source_reference);
      await model(c, run.model_id);
      const decision = choice(
        b.decision,
        ["accepted", "corrected", "rejected"],
        "Review",
      );
      if (run.created_by === c.actor.subject)
        fail("A different reviewer must confirm the inference");
      if (decision === "accepted" && run.result.available !== true)
        fail("An unavailable inference cannot be accepted");
      if (decision === "corrected") {
        if (run.purpose === "shelf")
          shelfFacts(b.correction?.detections, {
            expectedFacings: b.correction?.expectedFacings ?? {},
          });
        else if (
          !Number.isSafeInteger(b.correction?.quantityBase) ||
          b.correction.quantityBase < 0
        )
          fail("Supply nonnegative corrected base units");
      }
      const [review] =
        await c.db`insert into analytics_model_reviews(run_id,decision,correction,reason,reviewed_by) values(${run.id},${decision},${decision === "corrected" ? b.correction : null},${text(b.reason, "Review reason", 500)},${c.actor.subject}) returning id`;
      await c.db`update analytics_model_runs set status=${decision === "corrected" ? "corrected" : "reviewed"},updated_at=now() where id=${run.id}`;
      return review;
    },
  };
  for (const [action, work] of Object.entries(handlers))
    router.post(
      "/api/v1/analytics/models/" + action,
      async (/** @type {any} */ c) => {
        const result = await tx(c.db, async (db) => {
          const actor = await actorFor(db, c.actor.userId),
            local = { ...c, db, actor };
          if (!actor) fail("Access is no longer active");
          await requireCapability(local, "masterdata.manage");
          if (c.body?.modelId)
            await db`select id from analytics_model_versions where id=${uuid(c.body.modelId)} for update`;
          return work(local, c.body);
        });
        await installCtx.publish("analytics");
        return result;
      },
    );
}
