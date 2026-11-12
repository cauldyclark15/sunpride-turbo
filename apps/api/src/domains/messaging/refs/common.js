import { ApiError, notFound } from "../../../core/errors.js";
import { unitInScope } from "../../../core/hooks.js";
import { outletOwnerUnit, territoryOwnerUnit } from "../../org/scope.js";
import { accessibleOrder } from "../../orders/access.js";
import { accessVisit } from "../../visits/shared.js";
import { tripFor } from "../../van/access.js";
import { requireIssueAccess } from "../../issues/service.js";
import { uuid, invalid } from "../model.js";

export const types = Object.freeze([
  "user",
  "outlet",
  "product",
  "customer",
  "issue",
  "order",
  "visit",
  "territory",
  "route",
  "van_trip",
]);
/** Static SQL identifiers only; never supplied by the client. @type {Record<string,{table:string,title:string,subtitle:string,cap:string,path:string}>} */
const config = {
  user: {
    table: "users",
    title: "id",
    subtitle: "id",
    cap: "messaging.use",
    path: "/people",
  },
  outlet: {
    table: "outlets",
    title: "name",
    subtitle: "code",
    cap: "outlet.read",
    path: "/stores",
  },
  product: {
    table: "products",
    title: "name",
    subtitle: "code",
    cap: "outlet.read",
    path: "/products",
  },
  customer: {
    table: "customers",
    title: "name",
    subtitle: "code",
    cap: "report.read",
    path: "/customers",
  },
  issue: {
    table: "issues",
    title: "title",
    subtitle: "number",
    cap: "issues.read",
    path: "/issues",
  },
  order: {
    table: "orders",
    title: "order_number",
    subtitle: "status",
    cap: "report.read",
    path: "/orders",
  },
  visit: {
    table: "visit_executions",
    title: "service_date",
    subtitle: "state",
    cap: "visit.read",
    path: "/visits",
  },
  territory: {
    table: "territories",
    title: "name",
    subtitle: "code",
    cap: "territory.read",
    path: "/territories",
  },
  route: {
    table: "routes",
    title: "name",
    subtitle: "code",
    cap: "route.read",
    path: "/routes",
  },
  van_trip: {
    table: "van_trips",
    title: "trip_number",
    subtitle: "status",
    cap: "van.read",
    path: "/van/trips",
  },
};
/** @param {any} db @param {any} a @param {string|null} unit */
async function unitOK(db, a, unit) {
  return (
    ["super_admin", "analyst"].includes(a.role) ||
    !!(unit && (await unitInScope(db, a, unit)))
  );
}
/** @param {any} db @param {any} a @param {string} type @param {any} r */
async function access(db, a, type, r) {
  if (!a.capabilities.has(config[type]?.cap)) return false;
  switch (type) {
    case "user":
      return true;
    case "product":
      return true;
    case "issue":
      requireIssueAccess(r, a);
      return true;
    case "outlet":
      return unitOK(db, a, await outletOwnerUnit(db, r.id, Date.now()));
    case "territory":
      return unitOK(db, a, await territoryOwnerUnit(db, r.id));
    case "route": {
      const owners =
        await db`select o.org_unit_id from route_territories rt join territory_ownerships o on o.territory_id=rt.territory_id
    where rt.route_id=${r.id} and rt.deleted_at is null and o.deleted_at is null and rt.effective_from<=now() and (rt.effective_to is null or rt.effective_to>now()) and o.effective_from<=now() and (o.effective_to is null or o.effective_to>now())`;
      if (["super_admin", "analyst"].includes(a.role)) return true;
      for (const o of owners)
        if (await unitOK(db, a, o.org_unit_id)) return true;
      return false;
    }
    case "customer": {
      if (["super_admin", "analyst"].includes(a.role)) return true;
      const assignments =
        await db`select p.org_unit_id,p.user_id,p.auth_subject from sales_assignments s join profiles p on p.auth_subject=s.salesperson_subject or p.user_id::text=s.salesperson_subject
    where s.customer_code=${r.code} and s.territory=${r.territory} and s.active and p.status='active' and p.deleted_at is null`;
      for (const p of assignments)
        if (
          (a.role !== "sales" ||
            p.user_id === a.userId ||
            p.auth_subject === a.subject) &&
          (await unitOK(db, a, p.org_unit_id))
        )
          return true;
      return false;
    }
    case "order":
      await accessibleOrder({ db, actor: a }, r.id);
      return true;
    case "visit":
      await accessVisit({ db, actor: a }, r);
      return true;
    case "van_trip":
      await tripFor(db, a, r.id, "van.read", false);
      return true;
  }
  return false;
}
/** @param {any} db @param {string} type @param {string} id */
export async function find(db, type, id) {
  uuid(id);
  const c = config[type];
  if (!c) throw invalid("Unknown reference type");
  if (type === "user") {
    const [r] =
      await db`select u.id,p.name as display_name,p.role,a.avatar_blob_id,coalesce(a.display_name,p.name) as name,(a.user_id is not null) as is_agent from users u join profiles p on p.user_id=u.id left join chat_agents a on a.user_id=u.id
   where u.id=${id} and u.disabled_at is null and p.status='active' and p.deleted_at is null and (a.user_id is null or a.disabled_at is null)
   and p.role in ('super_admin','admin','operations','manager','approver','sales','analyst','viewer') and not exists(select 1 from distributor_users d where d.profile_id=p.id)`;
    return r ?? null;
  }
  const [r] = await db`select * from ${db(c.table)} where id=${id}`;
  return r && !r.deleted_at ? r : null;
}
/** @param {any} db @param {string} type @param {string} id */
export async function thumbBlob(db, type, id) {
  if (type === "user")
    return (
      (
        await db`select avatar_blob_id as file_id from chat_agents where user_id=${id}`
      )[0]?.file_id ?? null
    );
  if (type === "outlet")
    return (
      (
        await db`select file_id from outlet_photos where outlet_id=${id} and deleted_at is null order by ordinal limit 1`
      )[0]?.file_id ?? null
    );
  if (type === "product")
    return (
      (
        await db`select image_file_id as file_id from product_catalogue_versions where product_id=${id} and effective_from<=now() and (effective_to is null or effective_to>now()) order by revision desc limit 1`
      )[0]?.file_id ?? null
    );
  return null;
}
/** @param {any} db @param {any} actor @param {string[]} ids @param {string} type */
export async function resolveType(db, actor, ids, type) {
  const c = config[type];
  if (!c) throw invalid("Unknown reference type");
  const result = [];
  for (const id of ids) {
    const r = await find(db, type, id);
    const base = {
      type,
      id,
      title: "Missing item",
      subtitle: null,
      thumb_url: null,
      href: null,
      access: "missing",
    };
    if (!r) {
      result.push(base);
      continue;
    }
    let ok = false;
    try {
      ok = await access(db, actor, type, r);
    } catch (e) {
      if (!(e instanceof ApiError) || ![403, 404, 422].includes(e.status))
        throw e;
    }
    if (!ok) {
      result.push({ ...base, title: "Restricted item", access: "restricted" });
      continue;
    }
    const blob = await thumbBlob(db, type, id);
    const [catalogue] =
      type === "product"
        ? await db`select id from product_catalogue_versions where product_id=${id} and effective_from<=now() and (effective_to is null or effective_to>now()) and image_sha256 is not null and source='sample' order by revision desc limit 1`
        : [];
    result.push({
      ...base,
      title: String(
        type === "user"
          ? r.name
          : type === "visit"
            ? `Visit · ${String(r.service_date).slice(0, 10)}`
            : r[c.title],
      ),
      subtitle:
        type === "user"
          ? r.is_agent
            ? "Developer"
            : r.role.replaceAll("_", " ")
          : String(r[c.subtitle] ?? ""),
      thumb_url: blob
        ? `/api/v1/messaging/refs/${type}/${id}/thumb`
        : catalogue
          ? `/api/v1/masters/catalogue-images/${catalogue.id}`
          : null,
      href: type === "issue" ? `/issues/${r.number}` : `${c.path}/${id}`,
      access: "ok",
    });
  }
  return result;
}
/** Most candidate rows one search call may resolve (scope checks are per row). */
export const SEARCH_BUDGET = 200;
/** Search uses the SAME resolver and scope checks, continuing past restricted batches,
 * but within a candidate budget: `limit=1` can never walk a whole table. Pass one
 * `budget` object to share it across the types of one request.
 * @param {any} db @param {any} actor @param {string} q @param {number} limit @param {string} type
 * @param {{left:number}} [budget] */
export async function searchType(
  db,
  actor,
  q,
  limit,
  type,
  budget = { left: SEARCH_BUDGET },
) {
  const c = config[type];
  if (!c) throw invalid("Unknown reference type");
  // A type the actor can never read costs nothing.
  if (!actor.capabilities.has(c.cap)) return [];
  const result = [];
  let after = "00000000-0000-0000-0000-000000000000";
  while (budget.left > 0) {
    const take = Math.min(100, budget.left);
    const rows =
      type === "user"
        ? // The resolver's own eligibility filter, pushed into SQL.
          await db`select u.id from users u join profiles p on p.user_id=u.id left join chat_agents a on a.user_id=u.id
          where u.id>${after} and strpos(lower(p.name),lower(${q}))>0 and u.disabled_at is null and p.status='active' and p.deleted_at is null
          and (a.user_id is null or a.disabled_at is null)
          and p.role in ('super_admin','admin','operations','manager','approver','sales','analyst','viewer')
          and not exists(select 1 from distributor_users d where d.profile_id=p.id) order by u.id limit ${take}`
        : await db`select id from ${db(c.table)} where id>${after} and strpos(lower(concat_ws(' ',${db(c.title)},${db(c.subtitle)})),lower(${q}))>0 order by id limit ${take}`;
    budget.left -= rows.length;
    const entries = await resolveType(
      db,
      actor,
      rows.map((/** @type {any} */ r) => r.id),
      type,
    );
    result.push(...entries.filter((r) => r.access === "ok"));
    if (result.length >= limit || rows.length < take) break;
    after = rows.at(-1).id;
  }
  return result.slice(0, limit);
}
/** @param {any} db @param {any} actor @param {any[]} refs */
export async function resolveRefs(db, actor, refs) {
  return Promise.all(
    refs.map(async (r) => {
      if (!r || typeof r.type !== "string" || !types.includes(r.type))
        throw invalid("Unknown reference type");
      return (await resolveType(db, actor, [uuid(r.id)], r.type))[0];
    }),
  );
}
