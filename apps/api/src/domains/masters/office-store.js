import { requireCapability } from "../../core/capabilities.js";
import { ApiError } from "../../core/errors.js";
import { scopeFilterForActor } from "../org/scope.js";
import { allocate, outletCommand } from "../org/outlets.js";
import { required, uuid, rule } from "../org/model.js";
import { definitionsAt, reference, masterDto } from "./definitions.js";
import { placesConfigured } from "./places.js";

/** SP-0162 office Add store. Reuses the one outlet writer (`outletCommand create`) for the
 * store and its contact, then records a verified pin with source `office`.
 * @param {any} c @param {any} b */
export async function officeAddStore(c, b) {
  const actor = await requireCapability(c, "outlet.manage");
  const unitId = uuid(b.orgUnitId ?? actor.orgUnitId, "Area");
  const lat = Number(b.latitude),
    lng = Number(b.longitude);
  if (
    b.latitude == null ||
    b.longitude == null ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    Math.abs(lat) > 90 ||
    Math.abs(lng) > 180
  )
    rule("Set the store's location on the map.");
  const channel = await reference(c, b.channelId, "channel", c.now),
    sub = await reference(c, b.subchannelId, "subchannel", c.now);
  if (sub.data.channelId !== channel.id)
    rule("Choose the channel's matching sub-channel.");
  const ownerName = required(b.ownerName, "Owner name", 100);
  const ownerPhone = required(b.ownerPhone, "Owner phone", 40);
  if (ownerPhone.replace(/\D/g, "").length < 7)
    rule("Enter a complete owner phone number.");
  const placeId =
    typeof b.placeId === "string" && b.placeId.trim()
      ? required(b.placeId, "Address search place", 300)
      : null;
  const landmark =
    typeof b.landmark === "string" && b.landmark.trim()
      ? required(b.landmark, "Landmark", 200)
      : null;
  const code =
    typeof b.code === "string" && b.code.trim()
      ? b.code
      : await allocate(c, "customer");
  const reason = "Added from the office";
  const outletId = await outletCommand(c, "create", {
    name: b.name,
    code,
    custodianOrgUnitId: unitId,
    address: required(b.address, "Address", 500),
    ...(landmark ? { directions: landmark } : {}),
    status: "active",
    contacts: [{ name: ownerName, phone: ownerPhone }],
    reason,
  });
  await c.db`update outlets set channel_id=${channel.id},subchannel_id=${sub.id},place_id=${placeId},enrolment_status='approved' where id=${outletId}`;
  await c.db`insert into outlet_pins(outlet_id,latitude,longitude,radius_meters,source,status,effective_from,proposed_by,proposed_at,verified_by,verified_at,reviewer_reason,evidence_note) values(${outletId},${lat},${lng},75,'office','verified',${new Date(c.now)},${actor.subject},${new Date(c.now)},${actor.subject},${new Date(c.now)},${reason},${placeId ? "Pin from address search, checked on the map" : "Pin set on the map"})`;
  await c.db`insert into audit_logs(subject,action,entity_type,entity_id,details) values(${actor.userId},'SP-0162.store.office_add','outlet',${outletId},${JSON.stringify({ acknowledgedDuplicates: Array.isArray(b.acknowledgedDuplicateIds) ? b.acknowledgedDuplicateIds.length : 0 })})`;
  const [row] = await c.db`select code from outlets where id=${outletId}`;
  return { id: outletId, outletId, code: row.code };
}

/** GET /api/v1/masters/store-setup: what the office Add store form needs. @param {any} ctx */
export async function storeSetup(ctx) {
  const actor = await requireCapability(ctx, "outlet.manage");
  const { unitIds } = await scopeFilterForActor(ctx.db, actor);
  const units =
    await ctx.db`select id,name from org_units where status='active' and deleted_at is null and (${unitIds === null} or id::text=any(${ctx.db.array(unitIds ?? [], "TEXT")})) order by name limit 501`;
  return {
    units: units.slice(0, 500),
    defaultUnitId: actor.orgUnitId ?? null,
    addressSearch: placesConfigured(ctx.env),
    channels: (await definitionsAt(ctx, "channel"))
      .filter((/** @type {any} */ r) => r.status === "active")
      .map(masterDto),
    subchannels: (await definitionsAt(ctx, "subchannel"))
      .filter((/** @type {any} */ r) => r.status === "active")
      .map(masterDto),
  };
}

/** GET /api/v1/masters/store-locations?missing=1&q=&limit= — location coverage. @param {any} ctx */
export async function storeLocations(ctx) {
  const actor = await requireCapability(ctx, "outlet.read");
  const { unitIds } = await scopeFilterForActor(ctx.db, actor);
  const q = ctx.url.searchParams;
  const missing = q.get("missing") === "1";
  const text = (q.get("q") ?? "").trim().slice(0, 100);
  const limit = Math.min(200, Math.max(1, Number(q.get("limit")) || 50));
  if (!Number.isFinite(limit))
    throw new ApiError("invalid_request", 400, "Invalid page size.");
  const nationwide = unitIds === null,
    units = ctx.db.array(unitIds ?? [], "TEXT");
  const pinned = ctx.db`exists (select 1 from outlet_pins p where p.outlet_id=o.id and p.status='verified' and p.deleted_at is null and p.effective_from<=now() and (p.effective_to is null or p.effective_to>now()))`;
  const [counts] = await ctx.db`select count(*)::int total,
      count(*) filter (where ${pinned})::int located
    from outlets o where o.status='active' and o.deleted_at is null
      and (${nationwide} or o.custodian_org_unit_id::text=any(${units}))`;
  const rows =
    await ctx.db`select o.id,o.code,o.name,o.address,${pinned} located
    from outlets o where o.status='active' and o.deleted_at is null
      and (${nationwide} or o.custodian_org_unit_id::text=any(${units}))
      and (${!missing} or not ${pinned})
      and (${text === ""} or o.name ilike ${"%" + text.replace(/[%_\\]/g, "\\$&") + "%"} or o.code ilike ${text + "%"})
    order by o.name limit ${limit + 1}`;
  return {
    total: counts.total,
    located: counts.located,
    rows: rows.slice(0, limit).map((/** @type {any} */ r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      address: r.address ?? "",
      located: Boolean(r.located),
    })),
    truncated: rows.length > limit,
  };
}
