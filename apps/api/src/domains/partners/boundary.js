import { forbidden } from "../../core/errors.js";
import { isUuid } from "../../core/util.js";

/** F-322: membership history is a durable external-account marker. Expiry must
 * never turn a former partner staff login back into an ordinary employee.
 * SEAM(DISTRIBUTOR): canonical distributors/distributor_users, not a second model.
 * @param {any} db @param {any} actor @returns {Promise<any>}
 */
export async function partnerContext(db, actor) {
  if (!actor) return null;
  const history =
    await db`select 1 from distributor_users where profile_id=${actor.profileId} limit 1`;
  if (!history.length && !["agency", "distributor"].includes(actor.role))
    return null;
  const members =
    await db`select m.*,d.name,d.org_unit_id,d.partner_kind,d.status as partner_status,d.source,
    d.effective_to as partner_until from distributor_users m join distributors d on d.id=m.distributor_id
    join profiles p on p.id=m.profile_id join users u on u.id=p.user_id
    where m.profile_id=${actor.profileId} and p.user_id=${actor.userId} and p.status='active' and p.deleted_at is null
      and p.role=${actor.role} and u.disabled_at is null
      and m.effective_from<=now() and (m.effective_to is null or m.effective_to>now())
      and d.effective_from<=now() and (d.effective_to is null or d.effective_to>now())
      and d.status not in ('suspended','rejected')`;
  if (members.length !== 1)
    throw forbidden("Your partner access has ended", "out_of_scope");
  const m = members[0];
  if (m.partner_kind === "agency" && !["agency", "sales"].includes(actor.role))
    throw forbidden("Partner account role needs correction", "out_of_scope");
  if (
    m.partner_kind === "distributor" &&
    !(
      actor.role === "distributor" ||
      (actor.role === "sales" &&
        (m.grants.includes("dsr") || m.grants.includes("van")))
    )
  )
    throw forbidden(
      "Distributor staff must use distributor access",
      "out_of_scope",
    );
  return m;
}

/** F-407: agency and DSR share the same outlet boundary with their canonical grant owner.
 * Current withdrawal AND capture-time assignment must both authorize the source.
 * @param {any} db @param {any} member @param {number} [at] */
export async function partnerStoreGrants(db, member, at = Date.now()) {
  return member.partner_kind === "distributor"
    ? db`select id,outlet_id,effective_from,effective_to from distributor_outlets where distributor_id=${member.distributor_id}
      and effective_from<=now() and (effective_to is null or effective_to>now())
      and effective_from<=${new Date(at)} and (effective_to is null or effective_to>${new Date(at)}) order by id`
    : db`select id,outlet_id,effective_from,effective_to from partner_outlet_assignments where distributor_id=${member.distributor_id}
      and effective_from<=now() and (effective_to is null or effective_to>now())
      and effective_from<=${new Date(at)} and (effective_to is null or effective_to>${new Date(at)}) order by id`;
}

/** @param {any} db @param {any} actor @param {string} outletId @param {number} [at] */
export async function partnerOutlet(db, actor, outletId, at = Date.now()) {
  const m = await partnerContext(db, actor);
  if (!m) return null;
  if (
    !(
      (m.partner_kind === "agency" && m.grants.includes("field")) ||
      (m.partner_kind === "distributor" &&
        (m.grants.includes("dsr") || m.grants.includes("van")))
    ) ||
    actor.role !== "sales" ||
    !isUuid(outletId)
  )
    throw forbidden(
      "This partner account cannot record field work",
      "out_of_scope",
    );
  const grants = await partnerStoreGrants(db, m, at);
  const grant = grants.find((/** @type {any} */ g) => g.outlet_id === outletId);
  if (
    !grant ||
    new Date(m.effective_from).getTime() > at ||
    (m.effective_to && new Date(m.effective_to).getTime() <= at)
  )
    throw forbidden(
      "Store is not assigned to your organisation",
      "out_of_scope",
    );
  return m;
}

/** F-322 deny-by-default facade, including endpoints added by future lanes.
 * @param {any} c */
export async function enforcePartnerHttp(c) {
  if (
    [
      "/api/auth/sign-in",
      "/api/auth/sign-out",
      "/api/auth/change-password",
      "/api/auth/refresh",
    ].includes(c.url.pathname)
  )
    return;
  const m = await partnerContext(c.db, c.actor);
  if (!m) return;
  const path = c.url.pathname;
  if (
    m.partner_kind === "distributor" &&
    m.grants.includes("van") &&
    c.actor.role === "sales" &&
    path === "/api/v1/van/trip"
  )
    return;
  if (
    path === "/api/me" ||
    [
      "/api/auth/sign-out",
      "/api/auth/change-password",
      "/api/auth/refresh",
    ].includes(path)
  )
    return;
  if (
    m.partner_kind === "distributor" &&
    c.actor.role === "distributor" &&
    (path === "/api/v1/distributors" ||
      path.startsWith("/api/v1/distributors/"))
  )
    return;
  if (path === "/api/v1/partners" || path.startsWith("/api/v1/partners/"))
    return;
  // SEAM(DISTRIBUTOR): its existing bundle authorizes the exact membership,
  // dsr grant, private device scope and catalog. Never route it to field.bundle.
  if (
    m.partner_kind === "distributor" &&
    m.grants.includes("dsr") &&
    [
      "/api/sync/pull",
      "/api/devices/challenge",
      "/api/devices/bind",
      "/api/devices/mine",
    ].includes(path)
  )
    return;
  if (
    ((m.partner_kind === "agency" && m.grants.includes("field")) ||
      (m.partner_kind === "distributor" &&
        (m.grants.includes("dsr") || m.grants.includes("van")))) &&
    c.actor.role === "sales"
  ) {
    if (
      [
        "/api/sync/pull",
        "/api/sync/push",
        "/api/devices/challenge",
        "/api/devices/bind",
        "/api/devices/mine",
        "/api/media/claims",
        "/api/v1/location/consent",
        "/api/v1/location/end-day",
        "/api/v1/callflow/geofence/request",
      ].includes(path)
    )
      return;
  }
  throw forbidden(
    "Use your organisation's portal and assigned field work",
    "out_of_scope",
  );
}

/** Runs inside self-command transactions; no other person's data is granted.
 * @param {any} db @param {any} actor */
export async function enforcePartnerSelf(db, actor) {
  const m = await partnerContext(db, actor);
  if (!m) return;
  // Shared locks serialize withdrawal against business writes in this transaction.
  await db`select id from distributors where id=${m.distributor_id} for share`;
  await db`select id from distributor_users where id=${m.id} for share`;
  const current = await partnerContext(db, actor);
  if (
    !current ||
    current.id !== m.id ||
    !(
      (current.partner_kind === "agency" && current.grants.includes("field")) ||
      (current.partner_kind === "distributor" &&
        (current.grants.includes("dsr") || current.grants.includes("van")))
    ) ||
    actor.role !== "sales"
  )
    throw forbidden("Partner operation is not permitted", "out_of_scope");
  return current;
}

/** Runs INSIDE every op transaction, before even idempotent receipts.
 * @param {any} db @param {any} actor @param {any} op */
export async function enforcePartnerOp(db, actor, op) {
  const member = await enforcePartnerSelf(db, actor);
  if (!member) return;
  if (member.partner_kind === "distributor" && member.grants.includes("van")) {
    const { VAN_OPS } = await import("../van/operations.js");
    if (
      ![
        ...VAN_OPS,
        "call.start",
        "call.step",
        "call.close",
        "availability.record",
      ].includes(op.opType) ||
      !isUuid(op.payload?.tripId)
    )
      throw forbidden(
        "This operation is not enabled for partner vans",
        "out_of_scope",
      );
    const [trip] =
      await db`select * from van_trips where id=${op.payload.tripId} and deleted_at is null`;
    if (!trip) throw forbidden("Partner trip is unavailable", "out_of_scope");
    const { partnerVan } = await import("../van/partner.js");
    await partnerVan(db, actor, trip);
    const at = Number(op.payload.deviceTime ?? op.clientTime);
    if (
      !Number.isSafeInteger(at) ||
      at < +new Date(member.effective_from) ||
      (member.effective_to && at >= +new Date(member.effective_to))
    )
      throw forbidden(
        "Operation is outside the partner assignment",
        "out_of_scope",
      );
    if (op.payload.outletId)
      await partnerOutlet(db, actor, op.payload.outletId, at);
    return;
  }
  if (
    ![
      "visit.checkIn",
      "visit.activity",
      "visit.checkOut",
      "evidence.attach",
      "merchandising.record",
      "availability.record",
      ...(member.partner_kind === "distributor"
        ? ["availability.proposal"]
        : []),
      "retail.capture",
      "task.complete",
      "location.record",
    ].includes(op.opType)
  )
    throw forbidden(
      "This operation is not enabled for agency staff",
      "out_of_scope",
    );
  const p = op.payload;
  if (op.opType === "location.record") {
    const at = Number(p.recordedAt ?? op.clientTime);
    if (
      new Date(member.effective_from).getTime() > at ||
      (member.effective_to && new Date(member.effective_to).getTime() <= at)
    )
      throw forbidden(
        "Location predates your agency assignment",
        "out_of_scope",
      );
    return;
  }
  let outletId = p.outletId;
  if (op.opType !== "visit.checkIn") {
    if (!isUuid(p.visitId))
      throw forbidden("Your visit is required", "out_of_scope");
    const [v] =
      await db`select outlet_id,assignee_profile_id,started_at from visit_executions where id=${p.visitId} and deleted_at is null`;
    if (!v || v.assignee_profile_id !== actor.profileId)
      throw forbidden("Not your visit", "out_of_scope");
    outletId = v.outlet_id;
    await partnerOutlet(db, actor, outletId, new Date(v.started_at).getTime());
  }
  await partnerOutlet(
    db,
    actor,
    outletId,
    Number(p.deviceTime ?? op.clientTime),
  );
  if (
    op.opType === "visit.checkIn" &&
    (!Array.isArray(p.intents) ||
      p.intents.some(
        (/** @type {string} */ k) =>
          ![
            ...(member.partner_kind === "distributor"
              ? ["sell", "collect"]
              : []),
            "merchandise",
            "audit",
            "promotion",
            "complaint",
            "follow-up",
          ].includes(k),
      ))
  )
    throw forbidden("Choose execution-only call activities", "out_of_scope");
  if (
    op.opType === "visit.activity" &&
    ![
      ...(member.partner_kind === "distributor"
        ? ["order_intent", "call_sheet"]
        : []),
      "inventory_check",
      "merchandising",
      "price_check",
      "promotion",
      "note",
    ].includes(p.activity?.kind)
  )
    throw forbidden(
      "Commercial capture is not enabled for agency staff",
      "out_of_scope",
    );
}

/** @param {any} db @param {any} actor @param {any[]} scopes @param {boolean} delta */
export async function enforcePartnerPull(db, actor, scopes, delta) {
  const m = await partnerContext(db, actor);
  if (!m) return null;
  const partnerVan =
    m.partner_kind === "distributor" &&
    m.grants.includes("van") &&
    actor.role === "sales" &&
    scopes.every((s) => s.projection === "van.bundle");
  const distributor =
    m.partner_kind === "distributor" &&
    actor.role === "distributor" &&
    m.grants.includes("dsr") &&
    scopes.every((s) => s.projection === "distributor.bundle");
  if (
    !distributor &&
    !partnerVan &&
    (!(
      (m.partner_kind === "agency" && m.grants.includes("field")) ||
      (m.partner_kind === "distributor" && m.grants.includes("dsr"))
    ) ||
      actor.role !== "sales" ||
      scopes.some((s) => s.projection !== "field.bundle"))
  )
    throw forbidden(
      "This sync topic is outside your organisation",
      "out_of_scope",
    );
  // No unit-wide delta identifiers or tombstones escape to an external login.
  if (delta && !distributor)
    throw forbidden(
      "Refresh your assigned day snapshot",
      "rebootstrap_required",
    );
  const grants = await partnerStoreGrants(db, m);
  const arrangements = partnerVan
    ? await db`select effective_to from distributor_van_arrangements where distributor_id=${m.distributor_id} and effective_from<=now() and (effective_to is null or effective_to>now())`
    : [];
  m.leaseExpiresAt = Math.min(
    ...[
      m.effective_to,
      m.partner_until,
      ...grants.map((/** @type {any} */ g) => g.effective_to),
      ...arrangements.map((/** @type {any} */ a) => a.effective_to),
    ]
      .filter(Boolean)
      .map((v) => new Date(v).getTime()),
    Number.MAX_SAFE_INTEGER,
  );
  return m;
}

/** @param {any} db @param {any} actor @param {string} topic */
export async function partnerTopicAllowed(db, actor, topic) {
  const m = await partnerContext(db, actor);
  if (!m) return null;
  const prefix = m.partner_kind === "agency" ? "partner" : "distributor";
  return (
    topic === `${prefix}:${m.distributor_id}` &&
    (m.grants.includes("portal") || m.grants.includes("read"))
  );
}

/** @param {any} db @param {any} actor @param {any} claim */
export async function enforcePartnerMedia(db, actor, claim) {
  const m = await partnerContext(db, actor);
  if (!m) return;
  if (
    m.partner_kind === "distributor" &&
    m.grants.includes("van") &&
    claim.purpose === "truck-damage"
  ) {
    const { canClaimMedia } = await import("../van/media.js");
    if (await canClaimMedia(db, actor, claim)) return;
    throw forbidden("Partner trip media is unavailable", "out_of_scope");
  }
  if (claim.purpose !== "visit-photo" || !isUuid(claim.ownerId))
    throw forbidden("Partner media unavailable", "out_of_scope");
  const [device] =
    await db`select id from registered_devices where id=${claim.deviceId} and profile_id=${actor.profileId} and status='active' and bound_subject=${actor.subject} and org_unit_id=${actor.orgUnitId}`;
  if (!device) throw forbidden("Partner device access ended", "out_of_scope");
  const [v] =
    await db`select outlet_id,assignee_profile_id,started_at from visit_executions where id=${claim.ownerId} and deleted_at is null`;
  if (!v || v.assignee_profile_id !== actor.profileId)
    throw forbidden("Not your evidence", "out_of_scope");
  await partnerOutlet(db, actor, v.outlet_id, new Date(v.started_at).getTime());
}
