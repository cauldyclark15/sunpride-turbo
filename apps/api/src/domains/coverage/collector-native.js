import { ApiError, forbidden, invalid, conflict } from "../../core/errors.js";
import { requireCapability } from "../../core/capabilities.js";
import { OpRejected } from "../../core/sync.js";
import { sha256Hex } from "../../core/util.js";
import { required, uuid } from "../org/model.js";
import { validateCollectionJpeg } from "../masters/photo.js";
import { manilaDate } from "./model.js";
import { COLLECTOR_ACCESS } from "./collector-context.js";
import {
  customerFor,
  latestAr,
  createPromise,
  receiveCheque,
  chequeEvent,
  saveRoute,
} from "./collections.js";
const ACTIONS = ["promise", "cheque.receive", "cheque.bounced", "route.order"];
/** F-613: own dated route, never planner access to a team. Shared locks serialize withdrawal.
 * @param {any} c @param {any} p @param {boolean} [lock] */
async function assigned(c, p, lock = false) {
  await requireCapability(c, "collections.capture");
  if (
    typeof p.serviceDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(p.serviceDate)
  )
    throw invalid("Choose the downloaded collection day");
  if (lock)
    await c.db`select pg_advisory_xact_lock(hashtextextended(${"collect-route:" + p.serviceDate + ":" + c.actor.profileId},0))`;
  const rows =
    await c.db`select * from collection_route_stops where collector_profile_id=${c.actor.profileId} and route_date=${p.serviceDate}::date order by sequence ${lock ? c.db.unsafe("for share") : c.db.unsafe("")}`;
  if (rows.length > 60)
    throw conflict("Collection route exceeds its supported bound");
  for (const r of rows) {
    await requireCapability(c, "collections.capture", r.org_unit_id);
    const [owner] =
      await c.db`select 1 from analytics_store_scope where customer_code=${r.customer_code} and owner_unit_id=${r.org_unit_id} and status='active' limit 1`;
    if (!owner) throw forbidden("Collection account ownership changed");
  }
  if (
    p.action &&
    p.action !== "route.order" &&
    !rows.some((/** @type {any} */ r) => r.customer_code === p.customerCode)
  )
    throw forbidden(
      "This customer is not on your current assigned collection route",
    );
  return rows;
}
/** Only this module creates the private canonical-writer adapter. @param {any} c @param {any} p */
async function collectorContext(c, p) {
  const rows = await assigned(c, p, true),
    units = new Set(
      rows
        .filter(
          (/** @type {any} */ r) =>
            p.action === "route.order" || r.customer_code === p.customerCode,
        )
        .map((/** @type {any} */ r) => r.org_unit_id),
    );
  return {
    ...c,
    [COLLECTOR_ACCESS]: {
      authorize: async (
        /** @type {any} */ fresh,
        /** @type {string|null} */ unit,
      ) => {
        await requireCapability(fresh, "collections.capture", unit);
        if (unit && !units.has(unit))
          throw forbidden(
            "Collection grant does not include this current owner",
          );
        return fresh.actor;
      },
    },
  };
}
/** @param {any} db @param {any} actor @param {any} op */
export async function guardCollectionCapture(db, actor, op) {
  try {
    const p = op.payload,
      c = { db, actor, now: Date.now() };
    if (
      !ACTIONS.includes(p.action) ||
      manilaDate(op.clientTime) !== p.serviceDate ||
      op.clientTime > c.now + 60000 ||
      op.clientTime < c.now - 7 * 86400000
    )
      throw invalid("Capture must belong to the assigned service day");
    await assigned(c, p, true);
    if (p.action === "cheque.bounced" || p.replacesId) {
      const [q] =
        await db`select customer_code,org_unit_id from cheque_instruments where id=${uuid(p.action === "cheque.bounced" ? p.chequeId : p.replacesId)} for share`;
      if (!q || q.customer_code !== p.customerCode)
        throw forbidden("Choose this customer's recorded cheque");
      await requireCapability(c, "collections.capture", q.org_unit_id);
    }
  } catch (e) {
    if (e instanceof ApiError)
      throw new OpRejected(
        e.status === 403 || e.status === 404
          ? "out_of_scope"
          : "invalid_request",
      );
    throw e;
  }
}
/** @param {any} raw */
function photo(raw) {
  if (raw == null) return null;
  if (
    raw.mimeType !== "image/jpeg" ||
    typeof raw.bytesBase64 !== "string" ||
    raw.bytesBase64.length > 88000
  )
    throw invalid("Use a bounded JPEG capture");
  const bytes = Buffer.from(raw.bytesBase64, "base64");
  if (
    bytes.toString("base64") !== raw.bytesBase64 ||
    sha256Hex(bytes) !== raw.sha256
  )
    throw invalid("Photo bytes do not match their checksum");
  const size = validateCollectionJpeg(bytes);
  return {
    mimeType: "image/jpeg",
    bytesBase64: raw.bytesBase64,
    sha256: raw.sha256,
    ...size,
  };
}
/** @param {any} c */
export async function collectionAgenda(c) {
  const day = c.params.serviceDate;
  if (day !== manilaDate(c.now))
    throw invalid("Refresh today's collector agenda");
  const rows = await assigned(c, { serviceDate: day });
  const codes = rows.map((/** @type {any} */ r) => r.customer_code),
    ar = await latestAr(c.db, codes, day),
    stops = [];
  for (const r of rows) {
    const [store] =
      await c.db`select name from analytics_store_scope where customer_code=${r.customer_code} and owner_unit_id=${r.org_unit_id} and status='active' order by id limit 1`;
    const promises =
      await c.db`select id,amount_minor,promised_on,status,note from collection_promises where customer_code=${r.customer_code} and org_unit_id=${r.org_unit_id} and status='open' order by promised_on,id limit 101`;
    const cheques =
      await c.db`select id,bank,cheque_number,amount_minor,cheque_date,status from cheque_instruments where customer_code=${r.customer_code} and org_unit_id=${r.org_unit_id} and status in ('received','deposited','bounced') order by cheque_date,id limit 101`;
    if (promises.length > 100 || cheques.length > 100)
      throw conflict("Reconcile older account records before downloading more");
    const a = ar.get(r.customer_code);
    stops.push({
      customerCode: r.customer_code,
      name: store.name,
      sequence: r.sequence,
      reason: r.reason,
      ar: a ?? null,
      promises: promises.map((/** @type {any} */ p) => ({
        ...p,
        amountMinor: Number(p.amount_minor),
        promisedOn: manilaDate(+new Date(p.promised_on)),
      })),
      cheques: cheques.map((/** @type {any} */ q) => ({
        id: q.id,
        bank: q.bank,
        chequeNumber: q.cheque_number,
        amountMinor: Number(q.amount_minor),
        chequeDate: manilaDate(+new Date(q.cheque_date)),
        status: q.status,
      })),
    });
  }
  return {
    profileId: c.actor.profileId,
    serviceDate: day,
    stops,
    warning:
      "Cached replicated open items, not a live balance or a financial posting. Missing AR is unknown. Office confirmation and SAP still own cash and clearance.",
  };
}
/** @param {any} router @param {any} platform */
export function installCollectorCapture(router, platform) {
  platform.registerProjection("field.collections", {
    params: (/** @type {any} */ p) => ({
      serviceDate: required(p?.serviceDate, "Day", 10),
    }),
    snapshot: async (/** @type {any} */ c) => ({
      data: await collectionAgenda(c),
      next: null,
    }),
  });
  platform.registerOp(
    "collections.capture",
    async (/** @type {any} */ c) => {
      try {
        const p = c.payload;
        await guardCollectionCapture(c.db, c.actor, c.op);
        const cc = await collectorContext(c, p);
        if (p.action === "route.order") {
          const assignedRows = await assigned(c, p, true),
            order = p.customerCodes;
          if (
            !Array.isArray(order) ||
            order.length !== assignedRows.length ||
            new Set(order).size !== order.length ||
            assignedRows.some(
              (/** @type {any} */ r) => !order.includes(r.customer_code),
            )
          )
            throw invalid("Reorder every assigned stop exactly once");
          await saveRoute({
            ...cc,
            body: {
              routeDate: p.serviceDate,
              collectorProfileId: c.actor.profileId,
              stops: order.map((code) => ({
                customerCode: code,
                reason: assignedRows.find(
                  (/** @type {any} */ r) => r.customer_code === code,
                ).reason,
              })),
            },
          });
          c.publish("analytics");
          return { entityId: c.actor.profileId };
        }
        const body = { ...p, idempotencyKey: c.op.clientOpId },
          note = required(p.note, "Capture evidence note", 500),
          image = photo(p.photo);
        if (p.action === "promise" && (!p.openItemRef || !p.sourceHash))
          throw invalid("Choose the exact downloaded AR open item");
        /** @type {any} */ const result =
          p.action === "promise"
            ? await createPromise({ ...cc, body })
            : p.action === "cheque.receive"
              ? await receiveCheque({ ...cc, body })
              : await chequeEvent({
                  ...cc,
                  body: { ...body, kind: "bounced" },
                });
        const id = p.action === "cheque.bounced" ? p.chequeId : result.id;
        const rows = await assigned(c, p, true),
          unit = rows.find(
            (/** @type {any} */ r) => r.customer_code === p.customerCode,
          ).org_unit_id;
        await c.db`insert into collection_capture_evidence(org_unit_id,collector_profile_id,customer_code,route_date,promise_id,cheque_id,client_request_id,captured_at,note,photo) values(${unit},${c.actor.profileId},${p.customerCode},${p.serviceDate},${p.action === "promise" ? id : null},${p.action !== "promise" ? id : null},${c.op.clientOpId},${new Date(c.op.clientTime)},${note},${image})`;
        c.publish("analytics");
        return { entityId: id };
      } catch (e) {
        if (e instanceof ApiError)
          throw new OpRejected(
            e.status === 403 || e.status === 404
              ? "out_of_scope"
              : e.status === 409
                ? "idempotency_conflict"
                : "invalid_request",
          );
        throw e;
      }
    },
    guardCollectionCapture,
  );
  router.get(
    "/api/v1/money/collections/evidence",
    async (/** @type {any} */ c) => {
      await requireCapability(c, "collections.plan");
      const chequeId = c.url.searchParams.get("chequeId"),
        promiseId = c.url.searchParams.get("promiseId");
      if (!!chequeId === !!promiseId)
        throw invalid("Choose one promise or cheque");
      const id = uuid(chequeId ?? promiseId),
        table = chequeId
          ? c.db.unsafe("cheque_instruments")
          : c.db.unsafe("collection_promises");
      const [record] =
        await c.db`select customer_code,org_unit_id from ${table} where id=${id}`;
      if (!record) throw forbidden();
      await requireCapability(c, "collections.plan", record.org_unit_id);
      await customerFor(c, record.customer_code, manilaDate(c.now));
      const rows =
        await c.db`select e.id,e.note,e.photo,e.captured_at,e.received_at,p.name collector from collection_capture_evidence e join profiles p on p.id=e.collector_profile_id where (${chequeId !== null} and e.cheque_id=${id}) or (${promiseId !== null} and e.promise_id=${id}) order by received_at desc limit 21`;
      if (rows.length > 20) throw conflict("Narrow this evidence history");
      return {
        items: rows.map((/** @type {any} */ r) => ({
          ...r,
          capturedAt: +new Date(r.captured_at),
          receivedAt: +new Date(r.received_at),
        })),
      };
    },
  );
}
