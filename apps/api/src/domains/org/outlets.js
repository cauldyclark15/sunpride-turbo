import { requireCapability } from "../../core/capabilities.js";
import { ApiError } from "../../core/errors.js";
import {
  activeAt,
  code,
  get,
  history,
  insert,
  instant,
  integer,
  ms,
  overlaps,
  replaceInterval,
  required,
  rule,
  update,
  uuid,
} from "./model.js";
import { outletOwnerUnit, territoryOwnerUnit } from "./scope.js";
import { access } from "./readers.js";
import { activeUnit, assertUnlocked } from "./commands.js";

/** @typedef {import('./model.js').Ctx} Ctx */
/** @typedef {import('./model.js').Row} Row */
/** @param {Row} b */
export function validatePin(b) {
  if (
    !Number.isFinite(b.latitude) ||
    b.latitude < -90 ||
    b.latitude > 90 ||
    !Number.isFinite(b.longitude) ||
    b.longitude < -180 ||
    b.longitude > 180
  )
    rule("Invalid WGS84 coordinates");
  if (
    !Number.isFinite(b.radiusMeters ?? 75) ||
    (b.radiusMeters ?? 75) <= 0 ||
    (b.radiusMeters ?? 75) > 500
  )
    rule("Invalid geofence radius");
}
/** @param {Row} b */
function profileFields(b) {
  /** @type {Row} */ const fields = { name: required(b.name, "Name", 200) };
  if (b.status !== undefined) {
    if (!["active", "prospect"].includes(b.status))
      rule("Invalid outlet status");
    fields.status = b.status;
  }
  for (const [input, column] of Object.entries({
    channel: "channel",
    subchannel: "subchannel",
    classification: "classification",
    address: "address",
    directions: "directions",
    visitWindow: "visit_window",
  }))
    if (b[input] !== undefined)
      fields[column] = b[input] === "" ? null : required(b[input], input, 500);
  if (b.salesPotential !== undefined) {
    if (!Number.isFinite(b.salesPotential) || b.salesPotential < 0)
      rule("Invalid sales potential");
    fields.sales_potential = b.salesPotential;
  }
  if (b.preferredWeekday !== undefined)
    fields.preferred_weekday = integer(b.preferredWeekday, 0, 6);
  if (b.visitFrequencyDays !== undefined)
    fields.visit_frequency_days = integer(b.visitFrequencyDays, 1, 366);
  return fields;
}
/** @param {Ctx} c @param {string} outletId @param {any} contacts */
async function saveContacts(c, outletId, contacts) {
  if (contacts === undefined) return;
  if (!Array.isArray(contacts) || contacts.length > 10)
    rule("At most 10 contacts");
  await c.db`delete from outlet_contacts where outlet_id=${outletId}`;
  for (const [i, contact] of contacts.entries())
    await insert(c.db, "outlet_contacts", {
      outlet_id: outletId,
      ordinal: i,
      name: required(contact.name, "Contact name", 100),
      phone: contact.phone ? required(contact.phone, "Phone", 40) : null,
    });
}
/** @param {Ctx} c @param {string} fileId */
async function evidence(c, fileId) {
  const [file] =
    await c.db`select * from files where id=${uuid(fileId)} and status='stored' and created_by=${c.actor?.userId}`;
  if (
    !file ||
    Number(file.size) > 10 * 1024 * 1024 ||
    !["image/jpeg", "image/png", "application/pdf"].includes(file.mime)
  )
    rule("Attach a stored photo or customer information sheet owned by you");
  return file;
}
/** @param {Ctx} c @param {string} action @param {Row} b */
export async function outletCommand(c, action, b) {
  const actor = await requireCapability(c, "outlet.manage");
  const reason = required(b.reason, "Reason");
  if (action === "create") {
    await requireCapability(c, "outlet.manage", uuid(b.custodianOrgUnitId));
    await activeUnit(c, b.custodianOrgUnitId, c.now, c.now + 1);
    const storeCode = code(b.code);
    // Refuse a reused code in words instead of letting the unique index fail as a 500.
    const [taken] =
      await c.db`select 1 from outlets where organization_id='sunpride' and code=${storeCode}`;
    if (taken)
      rule(
        `Store code ${storeCode} is already used by another store. Use a different code or leave it blank.`,
      );
    const row = await insert(c.db, "outlets", {
      ...profileFields(b),
      organization_id: "sunpride",
      code: storeCode,
      custodian_org_unit_id: b.custodianOrgUnitId,
      status: b.status ?? "active",
      created_by: actor.subject,
    });
    await saveContacts(c, row.id, b.contacts);
    if (b.customerId)
      await changeLink(c, {
        outletId: row.id,
        customerId: b.customerId,
        effectiveFrom: c.now,
        source: b.customerLinkSource ?? "office",
        reason,
      });
    return row.id;
  }
  const outlet = await access(c, "outlets", uuid(b.outletId), "outlet.manage");
  if (outlet.status === "inactive") rule("Inactive outlet");
  if (action === "edit") {
    await update(c.db, "outlets", outlet.id, profileFields(b));
    await saveContacts(c, outlet.id, b.contacts);
    return null;
  }
  if (action === "deactivate") {
    await assertUnlocked(c, [outlet.id], [], c.now);
    const assignments = await history(
      c.db,
      "outlet_assignments",
      "outlet_id",
      outlet.id,
    );
    for (const a of assignments)
      if (overlaps(a, c.now))
        await update(c.db, "outlet_assignments", a.id, {
          effective_to: instant(Math.max(c.now, ms(a.effective_from) ?? c.now)),
        });
    await update(c.db, "outlets", outlet.id, { status: "inactive" });
    return null;
  }
  return changeLink(c, b);
}
/** @param {Ctx} c @param {Row} b */
async function changeLink(c, b) {
  const outlet = await access(c, "outlets", uuid(b.outletId), "outlet.manage");
  const from = b.effectiveFrom ?? c.now;
  instant(from, c.now);
  if (!b.customerId) {
    const rows = await history(
      c.db,
      "outlet_customer_links",
      "outlet_id",
      outlet.id,
    );
    for (const row of rows.filter((r) => overlaps(r, from)))
      await update(c.db, "outlet_customer_links", row.id, {
        effective_to: instant(Math.max(from, ms(row.effective_from) ?? from)),
      });
    return null;
  }
  const customer = await get(c.db, "customers", uuid(b.customerId));
  if (!customer.active) rule("Inactive customer");
  return (
    await replaceInterval(
      c.db,
      "outlet_customer_links",
      "outlet_id",
      outlet.id,
      from,
      {
        customer_id: customer.id,
        source: required(b.source ?? "office", "Source", 100),
        actor_subject: c.actor?.subject,
        reason: required(b.reason, "Reason"),
      },
    )
  ).id;
}

/** @param {Ctx} c @param {string} action @param {Row} b */
export async function pinCommand(c, action, b) {
  const actor = await requireCapability(
    c,
    action === "propose" ? "outlet.manage" : "outlet.verify",
  );
  if (action === "propose") {
    const outlet = await access(
      c,
      "outlets",
      uuid(b.outletId),
      "outlet.manage",
    );
    if (outlet.status === "inactive") rule("Inactive outlet");
    validatePin(b);
    const from = b.effectiveFrom ?? c.now;
    instant(from, c.now);
    required(b.reason, "Reason");
    if (b.evidenceStorageId) await evidence(c, b.evidenceStorageId);
    return (
      await insert(c.db, "outlet_pins", {
        outlet_id: outlet.id,
        latitude: b.latitude,
        longitude: b.longitude,
        radius_meters: b.radiusMeters ?? 75,
        source: required(b.source, "Source", 100),
        evidence_storage_id: b.evidenceStorageId,
        evidence_note: [
          b.evidenceNote?.trim(),
          `Proposal reason: ${b.reason.trim()}`,
        ]
          .filter(Boolean)
          .join(" · "),
        status: "pending",
        effective_from: instant(from),
        proposed_by: actor.subject,
        proposed_at: instant(c.now),
      })
    ).id;
  }
  const pin = await get(c.db, "outlet_pins", uuid(b.pinId));
  const outlet = await access(c, "outlets", pin.outlet_id, "outlet.verify");
  if (outlet.status === "inactive") rule("Inactive outlet");
  if (pin.status !== "pending") rule("Pin already reviewed");
  if (pin.proposed_by === actor.subject)
    rule("Independent verifier required", "self_verify");
  if (!["verified", "rejected"].includes(b.decision)) rule("Invalid decision");
  const reason = required(b.reason, "Review reason");
  let from = ms(pin.effective_from) ?? c.now;
  if (b.decision === "verified") {
    const rows = await history(c.db, "outlet_pins", "outlet_id", pin.outlet_id);
    from = Math.max(
      from,
      c.now,
      ...rows
        .filter((r) => r.status === "verified" && ms(r.effective_from) <= c.now)
        .map((r) => (ms(r.effective_from) ?? 0) + 1),
    );
    if (
      rows.some(
        (r) =>
          r.id !== pin.id &&
          r.status === "verified" &&
          ms(r.effective_from) >= from,
      )
    )
      rule("Future verified pin conflicts");
    for (const row of rows.filter(
      (r) => r.status === "verified" && activeAt(r, from),
    ))
      await update(c.db, "outlet_pins", row.id, {
        effective_to: instant(from),
      });
  }
  await update(c.db, "outlet_pins", pin.id, {
    status: b.decision,
    effective_from: instant(from),
    ...(b.decision === "rejected"
      ? { effective_to: instant(Math.max(from + 1, c.now)) }
      : {}),
    verified_by: actor.subject,
    verified_at: instant(c.now),
    reviewer_reason: reason,
  });
  return null;
}

/** Validate the whole interval against current/future territory owners and route membership. @param {Ctx} c @param {Row} b @param {number} from */
async function destination(c, b, from) {
  const territory = await get(c.db, "territories", uuid(b.territoryId));
  if (
    !activeAt(territory, from) ||
    territory.status !== "active" ||
    territory.effective_to != null
  )
    rule("Territory does not cover assignment");
  await access(c, "territories", territory.id, "outlet.assign");
  let cursor = from;
  for (const row of (
    await history(c.db, "territory_ownerships", "territory_id", territory.id)
  ).filter((r) => !r.deleted_at && overlaps(r, from))) {
    if (ms(row.effective_from) > cursor) rule("Territory ownership gap");
    await requireCapability(c, "outlet.assign", row.org_unit_id);
    cursor = Math.max(cursor, ms(row.effective_to) ?? Infinity);
  }
  if (cursor !== Infinity) rule("Territory owner does not cover assignment");
  if (b.routeId) {
    integer(b.sequence, 1);
    const route = await access(c, "routes", uuid(b.routeId), "route.read");
    if (
      !activeAt(route, from) ||
      route.status !== "active" ||
      route.effective_to != null
    )
      rule("Route does not cover assignment");
    let end = from;
    for (const rt of (
      await history(c.db, "route_territories", "route_id", route.id)
    ).filter((r) => !r.deleted_at && overlaps(r, from))) {
      if (rt.territory_id !== territory.id || ms(rt.effective_from) > end)
        rule("Route not in territory throughout interval");
      end = Math.max(end, ms(rt.effective_to) ?? Infinity);
    }
    if (end !== Infinity) rule("Route territory gap");
  } else if (b.sequence !== undefined) rule("Sequence requires route");
}
/** Atomic batch also powers reorder. Canceled pending rows remain zero-length for audit. @param {Ctx} c @param {string} action @param {Row} b */
export async function assignmentCommand(c, action, b) {
  const actor = await requireCapability(c, "outlet.assign");
  const from = b.effectiveFrom;
  instant(from, c.now);
  const reason = required(b.reason, "Reason");
  /** @type {Row[]} */ let changes =
    action === "batchAssign" ? b.assignments : [b];
  if (action === "reorder") {
    await access(c, "routes", uuid(b.routeId), "route.read");
    const rows = await history(
      c.db,
      "outlet_assignments",
      "route_id",
      b.routeId,
    );
    const active = rows.filter((r) => !r.deleted_at && activeAt(r, from));
    if (
      !Array.isArray(b.outletIds) ||
      active.length !== b.outletIds.length ||
      active.some((r) => !b.outletIds.includes(r.outlet_id)) ||
      rows.some((r) => ms(r.effective_from) > from)
    )
      rule("Reorder must include all stops without future schedule conflicts");
    changes = b.outletIds.map(
      (/** @type {string} */ id, /** @type {number} */ i) => ({
        outletId: id,
        routeId: b.routeId,
        territoryId: active.find((r) => r.outlet_id === id)?.territory_id,
        sequence: i + 1,
      }),
    );
  }
  if (
    !Array.isArray(changes) ||
    changes.length < 1 ||
    changes.length > 100 ||
    new Set(changes.map((v) => v.outletId)).size !== changes.length
  )
    rule("Batch must contain 1–100 distinct outlets");
  for (const change of changes) {
    const outlet = await access(
      c,
      "outlets",
      uuid(change.outletId),
      "outlet.assign",
    );
    if (outlet.status === "inactive") rule("Inactive outlet");
    const rows = await history(
      c.db,
      "outlet_assignments",
      "outlet_id",
      outlet.id,
    );
    const pending = rows.filter(
      (r) =>
        !r.deleted_at &&
        ms(r.effective_from) >= from &&
        ms(r.effective_from) !== ms(r.effective_to),
    );
    if (
      pending.length > 1 ||
      pending.some((r) => ms(r.effective_from) <= c.now)
    )
      rule("Overlapping or future outlet assignment");
    for (const prior of rows.filter(
      (r) => !r.deleted_at && overlaps(r, from),
    )) {
      const owner = await territoryOwnerUnit(
        c.db,
        prior.territory_id,
        Math.max(from, ms(prior.effective_from) ?? from),
      );
      if (!owner) rule("Source owner missing");
      await requireCapability(c, "outlet.assign", owner);
      await assertUnlocked(
        c,
        [outlet.id],
        [prior.route_id, change.routeId].filter(Boolean),
        from,
      );
    }
    await assertUnlocked(
      c,
      [outlet.id],
      change.routeId ? [change.routeId] : [],
      from,
    );
    await destination(c, change, from);
    if (change.routeId) {
      const future = await history(
        c.db,
        "outlet_assignments",
        "route_id",
        change.routeId,
      );
      if (
        future.some(
          (r) =>
            !r.deleted_at &&
            !changes.some((v) => v.outletId === r.outlet_id) &&
            overlaps(r, from) &&
            r.sequence === change.sequence,
        ) ||
        changes.some(
          (v) =>
            v !== change &&
            v.routeId === change.routeId &&
            v.sequence === change.sequence,
        )
      )
        rule(
          "Route sequence collision including future intervals",
          "sequence_collision",
        );
    }
  }
  const ids = [];
  for (const change of changes) {
    const rows = await history(
      c.db,
      "outlet_assignments",
      "outlet_id",
      change.outletId,
    );
    for (const prior of rows.filter((r) => !r.deleted_at && overlaps(r, from)))
      await update(c.db, "outlet_assignments", prior.id, {
        effective_to: instant(Math.max(ms(prior.effective_from) ?? from, from)),
      });
    ids.push(
      (
        await insert(c.db, "outlet_assignments", {
          outlet_id: change.outletId,
          territory_id: change.territoryId,
          route_id: change.routeId,
          sequence: change.sequence,
          effective_from: instant(from),
          actor_subject: actor.subject,
          reason,
        })
      ).id,
    );
  }
  return action === "assign" ? ids[0] : ids;
}

/** The one store-code allocator (SP-0082); census approval and office Add store reuse it.
 * @param {Ctx} c @param {'provisional'|'customer'} kind */
export async function allocate(c, kind) {
  const [settings] =
    await c.db`insert into outlet_code_settings(organization_id,prefix,digits,next_sequence,next_provisional_sequence,updated_by) values('sunpride','SP',6,1,1,${c.actor?.subject}) on conflict(organization_id) do update set organization_id=excluded.organization_id returning *`;
  const field =
    kind === "provisional" ? "next_provisional_sequence" : "next_sequence";
  for (let i = 0; i < 1000; i++) {
    const sequence = settings[field]++;
    const value =
      kind === "provisional"
        ? `PROV-${String(sequence).padStart(6, "0")}`
        : `${settings.prefix}${String(sequence).padStart(settings.digits, "0")}`;
    await update(c.db, "outlet_code_settings", settings.id, {
      [field]: sequence + 1,
    });
    const exists =
      await c.db`select id from outlets where code=${value} and organization_id='sunpride'`;
    if (!exists.length) return value;
  }
  rule("Unable to allocate a store code");
}
/** @param {Ctx} c @param {Row} row @param {string} kind @param {string} outletCode @param {string} [reason] */
async function enrolmentEvent(c, row, kind, outletCode, reason) {
  const outlet = await get(c.db, "outlets", row.outlet_id);
  await insert(c.db, "outlet_enrolment_events", {
    organization_id: "sunpride",
    enrolment_id: row.id,
    outlet_id: outlet.id,
    org_unit_id: row.org_unit_id,
    kind,
    outlet_name: outlet.name,
    outlet_code: outletCode,
    actor_name: c.actor?.name ?? "Office",
    proposed_by_profile_id: row.proposed_by_profile_id,
    reason,
  });
}
/** @param {Ctx} c @param {string} action @param {Row} b */
export async function enrolmentCommand(c, action, b) {
  const actor = await requireCapability(
    c,
    action === "propose"
      ? "outlet.enrol.propose"
      : action === "setCodeFormat"
        ? "admin.manage"
        : "outlet.enrol.approve",
  );
  if (action === "setCodeFormat") {
    const prefix = code(b.prefix);
    integer(b.digits, 3, 10);
    await allocate(c, "customer");
    await c.db`update outlet_code_settings set prefix=${prefix},digits=${b.digits},updated_by=${actor.subject} where organization_id='sunpride'`;
    return null;
  }
  if (action === "propose") {
    // SP-0170 field capture: an optional `customer` object carries the client's fields; its
    // Distribution Channel stands in for the old free-text channel.
    if (b.customer && typeof b.customer === "object" && !b.channel)
      b = { ...b, channel: b.customer.distributionChannelCode };
    let unit = actor.orgUnitId;
    if (b.territoryId) {
      await access(c, "territories", uuid(b.territoryId), "territory.read");
      unit = await territoryOwnerUnit(c.db, b.territoryId);
    }
    if (!unit) rule("Your access has no organizational scope");
    await requireCapability(c, "outlet.enrol.propose", unit);
    const clientRequestId = required(
      b.clientRequestId,
      "Client request id",
      100,
    );
    const [existing] =
      await c.db`select * from outlet_enrolments where proposed_by=${actor.subject} and client_request_id=${clientRequestId}`;
    if (existing) {
      await access(c, "outlets", existing.outlet_id, "outlet.read");
      if (
        (await get(c.db, "outlets", existing.outlet_id)).name !== b.name.trim()
      )
        rule("Request key reused for another store");
      return {
        outletId: existing.outlet_id,
        enrolmentId: existing.id,
        provisionalCode: existing.provisional_code,
        replayed: true,
      };
    }
    const fields = profileFields(b);
    validatePin(b);
    const photos = [
      ...new Set(/** @type {string[]} */ (b.photoStorageIds ?? [])),
    ];
    if (photos.length > 5 || (!photos.length && !b.cisStorageId))
      rule("Attach a customer information sheet or up to five store photos");
    for (const id of photos) await evidence(c, id);
    if (b.cisStorageId) await evidence(c, b.cisStorageId);
    required(b.address, "Address", 500);
    required(b.channel, "Channel", 100);
    required(b.contactName, "Contact name", 100);
    const provisionalCode = await allocate(c, "provisional");
    const outlet = await insert(c.db, "outlets", {
      ...fields,
      organization_id: "sunpride",
      code: provisionalCode,
      custodian_org_unit_id: unit,
      status: "active",
      enrolment_status: "provisional",
      created_by: actor.subject,
    });
    await saveContacts(c, outlet.id, [
      { name: b.contactName, phone: b.contactPhone },
    ]);
    const pin = await insert(c.db, "outlet_pins", {
      outlet_id: outlet.id,
      latitude: b.latitude,
      longitude: b.longitude,
      radius_meters: 75,
      source: "new_store_enrolment",
      evidence_storage_id: photos[0] ?? b.cisStorageId,
      evidence_note: b.note,
      status: "pending",
      effective_from: instant(c.now),
      proposed_by: actor.subject,
      proposed_at: instant(c.now),
    });
    if (b.territoryId)
      await insert(c.db, "outlet_assignments", {
        outlet_id: outlet.id,
        territory_id: b.territoryId,
        effective_from: instant(c.now),
        actor_subject: actor.subject,
        reason: "New store enrolment",
      });
    const row = await insert(c.db, "outlet_enrolments", {
      organization_id: "sunpride",
      outlet_id: outlet.id,
      org_unit_id: unit,
      territory_id: b.territoryId,
      pin_id: pin.id,
      status: "pending",
      provisional_code: provisionalCode,
      cis_storage_id: b.cisStorageId,
      client_request_id: clientRequestId,
      proposed_by: actor.subject,
      proposed_by_profile_id: actor.profileId,
      proposed_at: instant(c.now),
    });
    for (const [i, id] of photos.entries())
      await c.db`insert into outlet_enrolment_photos(outlet_enrolment_id,ordinal,file_id) values(${row.id},${i},${id})`;
    await enrolmentEvent(c, row, "proposed", provisionalCode);
    if (b.customer && typeof b.customer === "object") {
      const { saveCustomer } = await import("../masters/customers.js");
      await saveCustomer(
        c,
        {
          customer: {
            customerName: b.name,
            ...b.customer,
            latitude: b.latitude,
            longitude: b.longitude,
          },
          contactPerson: b.contactName,
          reason: "New store enrolment",
        },
        { outletId: outlet.id, fieldCapture: true },
      );
    }
    return {
      outletId: outlet.id,
      enrolmentId: row.id,
      provisionalCode,
      replayed: false,
    };
  }
  const row = await get(c.db, "outlet_enrolments", uuid(b.enrolmentId));
  const outlet = await access(
    c,
    "outlets",
    row.outlet_id,
    "outlet.enrol.approve",
  );
  if (row.status !== "pending") rule("Enrolment already decided");
  if (
    row.proposed_by === actor.subject ||
    row.proposed_by_profile_id === actor.profileId
  )
    rule("The proposer cannot decide their own store", "self_verify");
  if (!["approved", "rejected"].includes(b.decision)) rule("Invalid decision");
  const reason = required(b.reason, "Reason");
  let assigned = outlet.code;
  if (b.decision === "approved") {
    if (outlet.status === "inactive") rule("Outlet is inactive");
    assigned = await allocate(c, "customer");
    const pin = await get(c.db, "outlet_pins", row.pin_id);
    if (pin.status === "pending")
      await pinCommand(c, "decide", {
        pinId: pin.id,
        decision: "verified",
        reason,
      });
    await update(c.db, "outlets", outlet.id, {
      code: assigned,
      enrolment_status: "approved",
    });
  } else {
    await assertUnlocked(c, [outlet.id], [], c.now);
    const assignments = await history(
      c.db,
      "outlet_assignments",
      "outlet_id",
      outlet.id,
    );
    for (const a of assignments.filter((r) => overlaps(r, c.now)))
      await update(c.db, "outlet_assignments", a.id, {
        effective_to: instant(Math.max(c.now, ms(a.effective_from) ?? c.now)),
      });
    const pin = await get(c.db, "outlet_pins", row.pin_id);
    if (pin.status === "pending")
      await pinCommand(c, "decide", {
        pinId: pin.id,
        decision: "rejected",
        reason,
      });
    await update(c.db, "outlets", outlet.id, {
      status: "inactive",
      enrolment_status: "rejected",
    });
  }
  await update(c.db, "outlet_enrolments", row.id, {
    status: b.decision,
    assigned_code: b.decision === "approved" ? assigned : null,
    decided_by: actor.subject,
    decided_at: instant(c.now),
    decision_reason: reason,
  });
  await enrolmentEvent(c, row, b.decision, assigned, reason);
  // SP-0170: a customer-master store keeps its accounting customer 1:1 (approved code / inactive).
  const [profile] =
    await c.db`select 1 from customer_profiles where outlet_id=${outlet.id}`;
  if (profile) {
    const { syncAccountingCustomer } = await import("../masters/customers.js");
    await syncAccountingCustomer(c, outlet.id);
  }
  return { code: assigned };
}
