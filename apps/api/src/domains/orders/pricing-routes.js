import {
  requireCapability,
  requireNationalScope,
} from "../../core/capabilities.js";
import { recordChange } from "../../core/sync.js";
import { canonicalJson, sha256Hex } from "../../core/util.js";
import { audit, command, notify } from "./service.js";
import { baseQuantity, resolvePrice, validateRule } from "./pricing.js";
import {
  ORGANIZATION,
  MAX_CENTAVOS,
  channel,
  choice,
  fail,
  instant,
  integer,
  text,
  uuid,
} from "./validation.js";

/** Price masters are nationwide; an area editor must not change everyone else's prices. @param {any} c */
async function authorize(c) {
  await requireCapability(c, "masterdata.manage");
  await requireNationalScope(c, ["admin", "operations"]);
}
/** @param {any} c @param {string} entity @param {string} id */
async function touched(c, entity, id) {
  await audit(c, `${entity}.changed`, id, null, entity);
  await recordChange(c.db, { entity, entityId: id, scopeKey: "catalog" });
}
/** @param {any} r */
const listView = (r) => ({
  id: r.id,
  code: r.code,
  name: r.name,
  channelKey: r.channel_key,
  currency: r.currency,
  status: r.status,
  source: r.source,
  effectiveFrom: new Date(r.effective_from).getTime(),
  effectiveTo: r.effective_to ? new Date(r.effective_to).getTime() : null,
  lineCount: Number(r.line_count ?? 0),
});
/** @param {any} c @param {any} b */
async function saveList(c, b) {
  const code = text(b.priceListCode ?? b.code, "Price list code", 80),
    name = text(b.name ?? code, "Price list name", 160);
  const from = instant(b.effectiveFrom),
    to = b.effectiveTo == null ? null : instant(b.effectiveTo),
    key = channel(b.channelKey);
  if (to && to <= from) fail("End date must be after the start date");
  const status = choice(b.status ?? "active", ["active", "inactive"], "Status");
  await c.db`select pg_advisory_xact_lock(hashtextextended('orders:pricing',0))`;
  const [old] = b.id
    ? await c.db`select * from price_lists where id = ${uuid(b.id)} and organization_id = ${ORGANIZATION} and deleted_at is null for update`
    : [];
  if (b.id && !old) fail("Price list not found");
  if (
    old &&
    (old.code !== code ||
      new Date(old.effective_from).getTime() !== from.getTime() ||
      old.channel_key !== key)
  )
    fail(
      "Create a new list/version to change code, channel or start date; retained history is immutable",
    );
  const overlap =
    await c.db`select id from price_lists where organization_id = ${ORGANIZATION} and channel_key is not distinct from ${key}
    and status = 'active' and deleted_at is null and id <> ${old?.id ?? "00000000-0000-0000-0000-000000000000"}
    and effective_from < coalesce(${to},'infinity'::timestamptz) and (effective_to is null or effective_to > ${from})`;
  if (status === "active" && overlap.length)
    fail("Another price list already covers this channel and period");
  const [row] = old
    ? await c.db`update price_lists set name = ${name},status = ${status},effective_to = ${to} where id = ${old.id} returning *`
    : await c.db`insert into price_lists(organization_id,code,name,channel_key,currency,status,source,effective_from,effective_to)
      values(${ORGANIZATION},${code},${name},${key},'PHP',${status},'office',${from},${to}) returning *`;
  await touched(c, "price_list", row.id);
  return row;
}
/** All row errors collected before any write. @param {any} c @param {any} b */
async function importList(c, b) {
  const from = instant(b.effectiveFrom);
  text(b.priceListCode, "Price list code", 80);
  if (!Array.isArray(b.rows) || !b.rows.length || b.rows.length > 4000)
    fail("Import 1–4,000 rows");
  /** @type {{row:number,message:string}[]} */
  const errors = [];
  const seen = new Set();
  const valid = [];
  for (let i = 0; i < b.rows.length; i++) {
    const r = b.rows[i];
    try {
      text(r.productCode, "Product code", 100);
      text(r.uom, "Selling unit", 32);
      integer(r.unitPriceCentavos, "Unit price", MAX_CENTAVOS);
      const [p] =
        await c.db`select * from products where code = ${r.productCode} and active and deleted_at is null`;
      if (!p || (p.organization_id && p.organization_id !== ORGANIZATION))
        fail("Product is unknown or inactive");
      await baseQuantity(c.db, p, r.uom, 1, from.getTime());
      const key = `${p.id}|${r.uom}`;
      if (seen.has(key)) fail("Duplicate product and unit");
      seen.add(key);
      valid.push({ productId: p.id, uom: r.uom, price: r.unitPriceCentavos });
    } catch (e) {
      errors.push({
        row: i + 1,
        message: e instanceof Error ? e.message : "Invalid price row",
      });
    }
  }
  if (errors.length) return { ok: false, errors };
  await c.db`select pg_advisory_xact_lock(hashtextextended('orders:pricing',0))`;
  let [list] =
    await c.db`select * from price_lists where organization_id = ${ORGANIZATION} and code = ${b.priceListCode} and deleted_at is null for update`;
  if (!list) list = await saveList(c, { ...b, name: b.priceListCode });
  if (list.channel_key !== channel(b.channelKey))
    fail("Import channel differs from the stored list");
  if (
    from < new Date(list.effective_from) ||
    (list.effective_to && from >= new Date(list.effective_to))
  )
    fail("Import date is outside the list period");
  for (const r of valid) {
    const rows =
      await c.db`select * from price_list_lines where price_list_id = ${list.id} and product_id = ${r.productId} and uom = ${r.uom} and deleted_at is null order by effective_from for update`;
    const exact = rows.find(
      (/** @type {any} */ x) =>
        new Date(x.effective_from).getTime() === from.getTime(),
    );
    if (exact) {
      if (Number(exact.unit_price_minor) !== r.price)
        errors.push({
          row: valid.indexOf(r) + 1,
          message:
            "This effective date already has a different price; use a new effective date",
        });
      continue;
    }
    // Validation pass for every version before the write pass below.
  }
  if (errors.length) return { ok: false, errors };
  for (const r of valid) {
    const rows =
      await c.db`select * from price_list_lines where price_list_id = ${list.id} and product_id = ${r.productId} and uom = ${r.uom} and deleted_at is null order by effective_from for update`;
    if (
      rows.some(
        (/** @type {any} */ x) =>
          new Date(x.effective_from).getTime() === from.getTime(),
      )
    )
      continue;
    const future = rows.find(
      (/** @type {any} */ x) => new Date(x.effective_from) > from,
    );
    await c.db`update price_list_lines set effective_to = ${from} where price_list_id = ${list.id} and product_id = ${r.productId} and uom = ${r.uom}
      and deleted_at is null and effective_from < ${from} and (effective_to is null or effective_to > ${from})`;
    const [line] =
      await c.db`insert into price_list_lines(organization_id,price_list_id,product_id,uom,unit_price_minor,effective_from,effective_to)
      values(${ORGANIZATION},${list.id},${r.productId},${r.uom},${r.price},${from},${future?.effective_from ?? list.effective_to}) returning id`;
    await recordChange(c.db, {
      entity: "price_list_line",
      entityId: line.id,
      scopeKey: "catalog",
    });
  }
  await touched(c, "price_list", list.id);
  return { ok: true, errors: [] };
}
/** @param {any} router */
export function installPricingRoutes(router) {
  router.get("/api/v1/pricing/price-lists", async (/** @type {any} */ c) => {
    await requireCapability(c, "report.read");
    const rows =
      await c.db`select p.*, (select count(*) from price_list_lines l where l.price_list_id = p.id and l.deleted_at is null) as line_count
      from price_lists p where p.organization_id = ${ORGANIZATION} and p.deleted_at is null order by p.channel_key nulls first,p.effective_from desc limit 501`;
    if (rows.length > 500)
      fail(
        "More than 500 price versions; narrow the price history before managing it",
      );
    return { rows: rows.map(listView) };
  });
  router.get(
    "/api/v1/pricing/price-lists/detail",
    async (/** @type {any} */ c) => {
      await requireCapability(c, "report.read");
      const id = uuid(c.url.searchParams.get("id"));
      const [list] =
        await c.db`select * from price_lists where id = ${id} and organization_id = ${ORGANIZATION} and deleted_at is null`;
      if (!list) fail("Price list not found");
      const lines =
        await c.db`select l.*,p.code,p.name from price_list_lines l join products p on p.id = l.product_id where l.price_list_id = ${id} and l.deleted_at is null order by p.code,l.uom,l.effective_from`;
      return {
        ...listView(list),
        lines: lines.map((/** @type {any} */ l) => ({
          id: l.id,
          productCode: l.code,
          productName: l.name,
          uom: l.uom,
          unitPriceCentavos: Number(l.unit_price_minor),
          effectiveFrom: new Date(l.effective_from).getTime(),
          effectiveTo: l.effective_to
            ? new Date(l.effective_to).getTime()
            : null,
        })),
      };
    },
  );
  for (const action of ["save", "create", "update", "delete", "import"])
    router.post(
      `/api/v1/pricing/price-lists/${action}`,
      async (/** @type {any} */ c) => {
        const b = { ...c.body };
        b.idempotencyKey ??=
          c.req.headers.get("idempotency-key") ??
          `pricing:${action}:${sha256Hex(canonicalJson(b))}`;
        const result = await command(
          c,
          `price-list.${action}`,
          b,
          authorize,
          async (cc) => {
            if (action === "delete") {
              const id = uuid(b.id);
              await cc.db`update price_lists set deleted_at = now(),status = 'inactive' where id = ${id} and organization_id = ${ORGANIZATION}`;
              await touched(cc, "price_list", id);
              return { ok: true };
            }
            if (action === "import") return importList(cc, b);
            if (action === "update" && !b.id) fail("Price list is required");
            return { ok: true, list: listView(await saveList(cc, b)) };
          },
        );
        if (result.ok) await notify(c);
        return result;
      },
    );
  router.get("/api/v1/pricing/promotions", async (/** @type {any} */ c) => {
    await requireCapability(c, "report.read");
    const rows =
      await c.db`select * from promotions where organization_id = ${ORGANIZATION} and deleted_at is null order by code limit 501`;
    if (rows.length > 500) fail("Promotion history exceeds 500 rows");
    return {
      rows: rows.map((/** @type {any} */ r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        priceListId: r.price_list_id,
        rule: r.rule,
        status: r.status,
        source: r.source,
        effectiveFrom: new Date(r.effective_from).getTime(),
        effectiveTo: r.effective_to ? new Date(r.effective_to).getTime() : null,
      })),
    };
  });
  for (const action of ["save", "create", "update", "delete"])
    router.post(
      `/api/v1/pricing/promotions/${action}`,
      async (/** @type {any} */ c) => {
        const b = { ...c.body };
        b.idempotencyKey ??=
          c.req.headers.get("idempotency-key") ??
          `promotion:${action}:${sha256Hex(canonicalJson(b))}`;
        const result = await command(
          c,
          `promotion.${action}`,
          b,
          authorize,
          async (cc) => {
            if (action === "delete") {
              const id = uuid(b.id);
              await cc.db`update promotions set deleted_at = now(),status = 'inactive' where id = ${id} and organization_id = ${ORGANIZATION}`;
              await touched(cc, "promotion", id);
              return { ok: true, id };
            }
            const rule = validateRule(b.rule),
              from = instant(b.effectiveFrom),
              to = b.effectiveTo == null ? null : instant(b.effectiveTo);
            if (to && to <= from) fail("End date must follow the start date");
            const units =
              rule.kind === "bundle"
                ? rule.components
                : rule.kind === "buy_x_get_y"
                  ? [rule.buy, rule.free]
                  : [rule.item];
            for (const u of units) {
              const [p] =
                await cc.db`select * from products where id = ${uuid(u.productId)} and active and deleted_at is null`;
              if (
                !p ||
                (p.organization_id && p.organization_id !== ORGANIZATION)
              )
                fail("Promotion product is unavailable");
              await baseQuantity(cc.db, p, u.uom, u.quantity, from.getTime());
            }
            if (b.priceListId) {
              const [p] =
                await cc.db`select id from price_lists where id = ${uuid(b.priceListId)} and organization_id = ${ORGANIZATION} and deleted_at is null`;
              if (!p) fail("Price list not available");
            }
            const code = text(b.code, "Promotion code", 80),
              name = text(b.name, "Promotion name", 160),
              status = choice(
                b.status ?? "active",
                ["active", "inactive"],
                "Status",
              );
            let row;
            if (b.id)
              [row] =
                await cc.db`update promotions set name=${name},status=${status},effective_to=${to} where id=${uuid(b.id)} and organization_id=${ORGANIZATION} and rule=${rule} and effective_from=${from} and code=${code} and price_list_id is not distinct from ${b.priceListId ?? null} and deleted_at is null returning *`;
            else
              [row] =
                await cc.db`insert into promotions(organization_id,code,name,price_list_id,rule_kind,rule,status,source,effective_from,effective_to) values(${ORGANIZATION},${code},${name},${b.priceListId ?? null},${rule.kind},${rule},${status},'office',${from},${to}) returning *`;
            if (!row)
              fail(
                "Keep the stored rule/start date unchanged or create a new promotion version",
              );
            await touched(cc, "promotion", row.id);
            return { ok: true, id: row.id };
          },
        );
        await notify(c);
        return result;
      },
    );
  for (const path of ["matrix", "missing-prices"])
    router.get(`/api/v1/pricing/${path}`, async (/** @type {any} */ c) => {
      await requireCapability(c, "report.read");
      const q = c.url.searchParams,
        at = q.get("at") ? instant(q.get("at")).getTime() : c.now;
      const after = q.get("cursor") ?? "",
        search = (q.get("q") ?? "").slice(0, 100),
        wanted = channel(q.get("channel"));
      if (path === "missing-prices" && !wanted) fail("Choose a channel");
      const channels = wanted
        ? [wanted]
        : (
            await c.db`select distinct channel_key from price_lists where organization_id = ${ORGANIZATION} and deleted_at is null and channel_key is not null order by channel_key`
          ).map((/** @type {any} */ x) => x.channel_key);
      if (channels.length > 50)
        fail("Choose a channel before reading more than 50 channels");
      const products =
        await c.db`select * from products where active and deleted_at is null and (organization_id is null or organization_id = ${ORGANIZATION}) and code > ${after} and strpos(lower(code || ' ' || name),lower(${search})) > 0 order by code limit 101`;
      const rows = [];
      for (const p of products.slice(0, 100)) {
        const prices = [];
        for (const ch of channels)
          prices.push({
            channel: ch,
            ...(await resolvePrice(c.db, {
              organizationId: ORGANIZATION,
              productId: p.id,
              uom: p.uom,
              channelKey: ch,
              customerCode: null,
              at,
            })),
          });
        if (
          path === "matrix" ||
          prices.some((p) => p.unitPriceCentavos === null)
        )
          rows.push({
            productId: p.id,
            productCode: p.code,
            productName: p.name,
            uom: p.uom,
            prices,
          });
      }
      return {
        channels,
        rows,
        next: products.length > 100 ? products[99].code : null,
        asOf: at,
      };
    });
}
