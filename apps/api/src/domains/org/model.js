import { ApiError } from "../../core/errors.js";

export const ORGANIZATION = "sunpride";
/** @typedef {import('../../core/context.js').Ctx} Ctx */
/** @typedef {import('@sunpride/db/client').Db} Db */
/** @typedef {Record<string, any>} Row */
/** @param {string} message @param {string} [code] @returns {never} */
export function rule(message, code = "business_rule") {
  throw new ApiError(code, 422, message);
}
/** @param {any} value @param {string} label @param {number} [max] */
export function required(value, label, max = 500) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max)
    rule(`${label} required (max ${max})`);
  return value.trim();
}
/** @param {any} value */
export function code(value) {
  const result = required(value, "Code", 40).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{0,39}$/.test(result)) rule("Invalid code");
  return result;
}
/** @param {any} value @param {string} [label] */
export function uuid(value, label = "Selection") {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new ApiError("invalid_request", 400, `${label} is invalid`);
  return value;
}
/** @param {any} value @param {number} [min] @param {number} [max] */
export function integer(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    rule(`Enter a whole number from ${min} to ${max}`);
  return /** @type {number} */ (value);
}
/** @param {any} value @param {number} [now] */
export function instant(value, now) {
  integer(value, 0, 8640000000000000);
  if (now !== undefined && value < now)
    rule("Changes must be future-effective", "not_prospective");
  return new Date(value);
}
/** @overload @param {Date|string|number} value @returns {number} */
/** @overload @param {null|undefined} value @returns {null} */
/** @param {any} value @returns {number|null} */
export function ms(value) {
  return value == null ? null : new Date(value).getTime();
}
/** @param {Row} row @param {number} at */
export const activeAt = (row, at) =>
  ms(row.effective_from) <= at &&
  (row.effective_to == null || at < ms(row.effective_to));
/** @param {Row} row @param {number} from @param {number} [to] */
export const overlaps = (row, from, to = Infinity) =>
  ms(row.effective_from) < to &&
  from < (ms(row.effective_to) ?? Infinity) &&
  ms(row.effective_from) !== ms(row.effective_to);
/** Convert SQL rows at the boundary. Optional NULL columns are omitted, not false/zero. @param {any} row @returns {Row} */
export function dto(row) {
  if (!row) return row;
  /** @type {Row} */ const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === "search_vector" || value == null) continue;
    const name = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    // Parameterised `db.unsafe` reads return int[] columns as typed arrays, which JSON
    // would encode as {"0":1,...}; clients expect plain lists.
    out[name] =
      value instanceof Date
        ? value.getTime()
        : ArrayBuffer.isView(value) &&
            !(value instanceof DataView) &&
            !(value instanceof Uint8Array)
          ? Array.from(/** @type {any} */ (value))
          : value;
  }
  if (row.id) out._id = row.id;
  return out;
}
/** @param {any} value @returns {string} */
export function canonical(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(",")}}`;
}
/** @param {Ctx} ctx */
export function query(ctx) {
  const raw = ctx.url.searchParams;
  /** @type {Row} */ const result = Object.fromEntries(raw);
  for (const key of ["asOf", "limit"])
    if (raw.has(key)) result[key] = Number(raw.get(key));
  if (raw.has("paginationOpts")) {
    try {
      result.paginationOpts = JSON.parse(raw.get("paginationOpts") ?? "");
    } catch {
      throw new ApiError("invalid_request", 400, "Invalid page");
    }
  }
  return result;
}
/** @param {Row} input */
export function paging(input) {
  const size = Number(input.paginationOpts?.numItems ?? input.limit ?? 25);
  integer(size, 1, 100);
  const cursor = input.paginationOpts?.cursor ?? input.cursor ?? null;
  if (cursor != null) uuid(cursor, "Page cursor");
  return {
    size,
    cursor,
    q: String(input.q ?? input.search ?? "")
      .trim()
      .slice(0, 200),
  };
}
/** @param {Row[]} rows @param {number} size */
export function page(rows, size) {
  const selected = rows.slice(0, size);
  const next = rows.length > size ? (selected.at(-1)?.id ?? null) : null;
  return {
    page: selected.map(dto),
    next,
    continueCursor: next ?? "",
    isDone: !next,
  };
}

// Identifiers are a closed server-owned allowlist; VALUES always use SQL parameters.
export const TABLES = new Set([
  "org_units",
  "org_unit_types",
  "org_unit_parent_edges",
  "profiles",
  "employee_assignments",
  "positions",
  "position_standards",
  "teams",
  "team_memberships",
  "territories",
  "territory_ownerships",
  "territory_salespeople",
  "routes",
  "route_territories",
  "route_salespeople",
  "outlets",
  "outlet_assignments",
  "outlet_pins",
  "outlet_customer_links",
  "outlet_contacts",
  "outlet_enrolments",
  "outlet_enrolment_events",
  "outlet_code_settings",
  "products",
  "units_of_measure",
  "uom_conversions",
  "product_barcodes",
  "customers",
  "access_invitations",
  "registered_devices",
]);
/** @param {Db} db @param {string} table @param {string} id @returns {Promise<Row>} */
export async function get(db, table, id) {
  if (!TABLES.has(table)) throw new Error("Unknown ORG table");
  uuid(id);
  const [row] = await db.unsafe(`select * from ${table} where id = $1`, [id]);
  if (!row || row.deleted_at)
    throw new ApiError("not_found", 404, "Record not found");
  return row;
}
/** Bounded history, explicit failure rather than silently truncated rules. @param {Db} db @param {string} table @param {string} field @param {string} id @returns {Promise<Row[]>} */
export async function history(db, table, field, id) {
  if (
    !TABLES.has(table) ||
    !/^(unit|profile|position|team|territory|route|outlet)_id$/.test(field)
  )
    throw new Error("Unknown history");
  uuid(id);
  const rows = await db.unsafe(
    `select * from ${table} where ${field} = $1 order by effective_from, id limit 501`,
    [id],
  );
  if (rows.length > 500) rule("History exceeds supported size", "overflow");
  return rows;
}
/** @param {Db} db @param {string} table @param {Row} values */
export async function insert(db, table, values) {
  if (!TABLES.has(table)) throw new Error("Unknown ORG table");
  const keys = Object.keys(values);
  if (keys.some((k) => !/^[a-z_]+$/.test(k))) throw new Error("Invalid column");
  const [row] = await db.unsafe(
    `insert into ${table} (${keys.join(",")}) values (${keys.map((_, i) => `$${i + 1}`).join(",")}) returning *`,
    keys.map((k) =>
      Array.isArray(values[k])
        ? `{${values[k].join(",")}}`
        : (values[k] ?? null),
    ),
  );
  return /** @type {Row} */ (row);
}
/** @param {Db} db @param {string} table @param {string} id @param {Row} values */
export async function update(db, table, id, values) {
  if (!TABLES.has(table)) throw new Error("Unknown ORG table");
  const keys = Object.keys(values);
  if (keys.some((k) => !/^[a-z_]+$/.test(k))) throw new Error("Invalid column");
  const [row] = await db.unsafe(
    `update ${table} set ${keys.map((k, i) => `${k} = $${i + 2}`).join(",")} where id = $1 returning *`,
    [
      id,
      ...keys.map((k) =>
        Array.isArray(values[k])
          ? `{${values[k].join(",")}}`
          : (values[k] ?? null),
      ),
    ],
  );
  return /** @type {Row} */ (row);
}
/** Close the existing open interval and append. Reject pending or bounded collisions. @param {Db} db @param {string} table @param {string} field @param {string} id @param {number} from @param {Row} values */
export async function replaceInterval(db, table, field, id, from, values) {
  const rows = await history(db, table, field, id);
  if (
    rows.some(
      (r) =>
        !r.deleted_at &&
        ms(r.effective_from) >= from &&
        ms(r.effective_from) !== ms(r.effective_to),
    )
  )
    rule("Future interval conflicts", "overlap");
  const current = rows.find((r) => !r.deleted_at && activeAt(r, from));
  if (current)
    await update(db, table, current.id, { effective_to: new Date(from) });
  return insert(db, table, {
    [field]: id,
    ...values,
    effective_from: new Date(from),
  });
}
