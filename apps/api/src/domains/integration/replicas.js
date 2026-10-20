import { tx } from "@sunpride/db/client";
import {
  validate,
  masterKinds,
  payloadHash,
} from "../../../../../packages/integration-contracts/sap/v1/index.js";
import { recordChange } from "../../core/sync.js";
import { receiveEvent, resolution } from "./outbox.js";
import { sapRequest, SapFailure } from "./transport.js";

/** Stable sync identity across SAP versions. @param {string} kind @param {string} key */
export function masterId(kind, key) {
  const h = payloadHash([kind, key]);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** F-015: SAP owns units; incompatible used conversions are rejected, never rewritten.
 * @param {any} db @param {string} code
 */
async function unit(db, code) {
  const [r] =
    await db`insert into units_of_measure(organization_id,code,name,dimension,decimal_places,active,external_code)
    values('sunpride',${code},${code},'count',0,true,${code}) on conflict(organization_id,code) do update set external_code=excluded.external_code returning *`;
  return r;
}
/** @param {any} db @param {any} m */
async function materialize(db, m) {
  await db`select set_config('sunpride.sap_ingest','on',true)`;
  const d = m.payload.data,
    deleted = m.deleted_at !== null,
    at = new Date(m.effective_from);
  if (m.kind === "material") {
    if (
      new Set(d.packs.map((/** @type {any} */ p) => p.uom)).size !==
      d.packs.length
    )
      throw new SapFailure("contract", false);
    for (const pack of d.packs) {
      const seen = new Set([pack.uom]);
      let parent = pack.parentUom;
      while (parent) {
        if (seen.has(parent)) throw new SapFailure("contract", false);
        seen.add(parent);
        const next = d.packs.find((/** @type {any} */ p) => p.uom === parent);
        if (!next && parent !== d.baseUom)
          throw new SapFailure("contract", false);
        parent = next?.parentUom ?? null;
      }
      if (pack.uom === d.baseUom && pack.numerator !== pack.denominator)
        throw new SapFailure("contract", false);
    }
    const base = await unit(db, d.baseUom);
    const [old] =
      await db`select * from products where code=${d.code} for update`;
    if (
      old?.sap_version != null &&
      Number(old.sap_version) > Number(m.sap_version)
    )
      return;
    if (
      old &&
      (old.base_uom_id !== base.id ||
        Number(old.quantity_scale) !== d.quantityScale ||
        old.tracking_mode !== d.tracking)
    ) {
      const [used] =
        await db`select 1 from inventory_movement_lines where product_id=${old.id} union all select 1 from order_lines where product_id=${old.id} limit 1`;
      if (used) throw new SapFailure("conflict", false);
    }
    const [product] =
      await db`insert into products(code,name,category,uom,unit_price,active,external_id,organization_id,base_uom_id,quantity_scale,tracking_mode,allocation_policy,policy_version,catalog_source,catalog_updated_at,sap_key,sap_version,sap_received_at,shelf_life_days,storage_condition)
      values(${d.code},${d.name},${d.category},${d.baseUom},0,${!deleted && d.status === "active"},${m.sap_key},'sunpride',${base.id},${d.quantityScale},${d.tracking},'fefo',1,${m.source === "sample" ? "sap_sample" : "sap"},now(),${m.sap_key},${m.sap_version},now(),${d.shelfLifeDays},${d.storageCondition})
      on conflict(code) do update set name=excluded.name,category=excluded.category,uom=excluded.uom,active=excluded.active,base_uom_id=excluded.base_uom_id,quantity_scale=excluded.quantity_scale,tracking_mode=excluded.tracking_mode,catalog_source=excluded.catalog_source,catalog_updated_at=now(),sap_key=excluded.sap_key,sap_version=excluded.sap_version,sap_received_at=now(),shelf_life_days=excluded.shelf_life_days,storage_condition=excluded.storage_condition returning *`;
    const codes = new Set([d.baseUom]);
    for (const p of d.packs) {
      if (codes.has(p.uom) && p.uom !== d.baseUom)
        throw new SapFailure("contract", false);
      codes.add(p.uom);
      const selling = await unit(db, p.uom);
      if (
        p.parentUom &&
        p.parentUom !== d.baseUom &&
        !d.packs.some((/** @type {any} */ x) => x.uom === p.parentUom)
      )
        throw new SapFailure("contract", false);
      // v1 exact conversion is always to base. Parent is display hierarchy only.
      if (selling.id !== base.id) {
        const conversions =
          await db`select * from uom_conversions where product_id=${product.id} and from_uom_id=${selling.id} and to_uom_id=${base.id} and active and deleted_at is null and (effective_to is null or effective_to>${at})`;
        if (
          conversions.some(
            (/** @type {any} */ c) =>
              Number(c.numerator) !== p.numerator ||
              Number(c.denominator) !== p.denominator,
          )
        )
          throw new SapFailure("conflict", false);
        if (!conversions.length)
          await db`insert into uom_conversions(organization_id,product_id,from_uom_id,to_uom_id,numerator,denominator,rounding_mode,effective_from,active) values('sunpride',${product.id},${selling.id},${base.id},${p.numerator},${p.denominator},'exact',${at},true)`;
      }
      const [allowed] =
        await db`select id from product_selling_uoms where product_id=${product.id} and uom_id=${selling.id} and deleted_at is null`;
      if (!allowed) {
        const [last] =
          await db`select coalesce(max(ordinal),-1)+1 as n from product_selling_uoms where product_id=${product.id}`;
        await db`insert into product_selling_uoms(product_id,ordinal,uom_id) values(${product.id},${last.n},${selling.id})`;
      }
      if (p.barcode) {
        const [barcode] =
          await db`select * from product_barcodes where organization_id='sunpride' and barcode=${p.barcode} and deleted_at is null`;
        if (
          barcode &&
          (barcode.product_id !== product.id || barcode.uom_id !== selling.id)
        )
          throw new SapFailure("conflict", false);
        if (barcode)
          await db`update product_barcodes set source='sap',active=${!deleted} where id=${barcode.id}`;
        if (!barcode)
          await db`insert into product_barcodes(organization_id,product_id,barcode,uom_id,active,source) values('sunpride',${product.id},${p.barcode},${selling.id},${!deleted},'sap')`;
      }
    }
    const currentBarcodes = d.packs
      .map((/** @type {any} */ p) => p.barcode)
      .filter(Boolean);
    await db`update product_barcodes set active=false where product_id=${product.id} and source='sap' and (${deleted} or barcode not in ${db(currentBarcodes.length ? currentBarcodes : ["__no_sap_barcode__"])})`;
    const currentUnits =
      await db`select id from units_of_measure where organization_id='sunpride' and code in ${db([...codes])}`;
    await db`update product_selling_uoms set deleted_at=now() where product_id=${product.id} and deleted_at is null and uom_id not in ${db(currentUnits.map((/** @type {any} */ u) => u.id))}`;
  }
  if (m.kind === "customer")
    await db`insert into customers(code,name,channel,territory,credit_limit,active,external_id)
    values(${d.code},${d.name},${d.channel},${d.territory},0,${!deleted && d.status === "active"},${m.sap_key}) on conflict(code) do update set name=excluded.name,channel=excluded.channel,territory=excluded.territory,active=excluded.active,external_id=excluded.external_id`;
  if (m.kind === "outlet")
    await db`update outlets set name=${d.name},address=${d.address} where code=${d.code} and deleted_at is null`;
  if (m.kind === "location")
    await db`update inventory_locations set sap_plant=${d.plant},sap_storage_location=${d.storageLocation},sap_version=${m.sap_version},sap_received_at=now() where code=${d.locationCode} and deleted_at is null and sap_version is distinct from ${m.sap_version}`;
  if (m.kind === "stock")
    await db`update inventory_balances b set sap_value_minor=${deleted ? null : d.valueCentavos},sap_value_as_of=${at},valuation_source=${deleted ? "unknown" : m.source === "sample" ? "sap_sample" : "sap"} from products p,inventory_locations l where b.product_id=p.id and b.location_id=l.id and p.code=${d.productCode} and l.code=${d.locationCode} and (b.sap_value_as_of is distinct from ${at} or b.sap_value_minor is distinct from ${deleted ? null : d.valueCentavos})`;
  if (m.kind === "stock" && !deleted) {
    const [p] = await db`select id from products where code=${d.productCode}`;
    const [l] =
      await db`select id from inventory_locations where code=${d.locationCode}`;
    const [b] =
      p && l
        ? await db`select physical_base from inventory_balances where product_id=${p.id} and location_id=${l.id}`
        : [];
    await db`insert into sap_inventory_snapshots(organization_id,product_code,warehouse_code,product_id,location_id,on_hand_base,reserved_base,available_base,as_of,source_event_id,source_sequence,payload_hash,resolution_status,received_at) values('sunpride',${d.productCode},${d.locationCode},${p?.id ?? null},${l?.id ?? null},${d.onHandBase},${d.reservedBase},${String(BigInt(d.onHandBase) - BigInt(d.reservedBase))},${at},${`sap:${m.sap_key}:${m.sap_version}`},${String(m.sap_version)},${m.payload_hash},${!p || !l ? "unmapped" : Number(b?.physical_base) === d.onHandBase ? "matched" : "different"},now()) on conflict(organization_id,source_event_id) do nothing`;
  }
}
/** @param {any} db @param {any} m */
async function storeReplica(db, m) {
  await db`select set_config('sunpride.sap_ingest','on',true)`;
  validate(m.kind, m);
  if (
    !masterKinds.includes(m.kind) ||
    (m.effectiveTo !== null && m.effectiveTo <= m.effectiveFrom)
  )
    throw new SapFailure("contract", false);
  const [old] =
    await db`select * from sap_replicas where organization_id='sunpride' and kind=${m.kind} and sap_key=${m.key} order by sap_version desc limit 1 for update`;
  const hash = payloadHash(m);
  if (old && Number(old.sap_version) > m.version) return { ignored: true };
  if (old && Number(old.sap_version) === m.version) {
    if (old.payload_hash !== hash) throw new SapFailure("conflict", false);
    return { duplicate: true };
  }
  let priceListId = null;
  if (m.kind === "condition") {
    const d = m.data;
    const [list] =
      await db`insert into price_lists(organization_id,code,name,channel_key,currency,status,source,effective_from) values('sunpride',${`SAP-${d.priceListCode}`},${`SAP ${d.priceListCode}`},${d.channelKey},'PHP','active','sap',${new Date(m.effectiveFrom)}) on conflict(organization_id,code) do update set source='sap' returning id`;
    priceListId = list.id;
  }
  const [r] =
    await db`insert into sap_replicas(organization_id,master_id,kind,sap_key,sap_version,source,effective_from,effective_to,payload_hash,payload,deleted_at,price_list_id)
    values('sunpride',${masterId(m.kind, m.key)},${m.kind},${m.key},${m.version},${m.source},${new Date(m.effectiveFrom)},${m.effectiveTo === null ? null : new Date(m.effectiveTo)},${hash},${m},${m.deleted ? new Date() : null},${priceListId}) returning *`;
  if (m.source === "sample")
    await db`insert into sample_data_rows(batch,table_name,row_id,key) values('sunpride-sap-sample-v1','sap_replicas',${r.id},${`replica:${m.kind}:${m.key}:${m.version}`}) on conflict do nothing`;
  if (
    m.effectiveFrom <= Date.now() &&
    (m.effectiveTo === null || m.effectiveTo > Date.now())
  )
    await materialize(db, r);
  await recordChange(db, {
    entity: "sap.master",
    entityId: r.master_id,
    scopeKey: "sap:masters",
    op: "upsert",
  });
  return { id: r.id };
}
/** F-002/F-003 durable inbox; bad business records remain visible while feed paging advances.
 * @param {any} db @param {any} m
 */
export async function ingestMaster(db, m) {
  validate(m.kind, m);
  return tx(db, async (t) => {
    const received = await receiveEvent(t, {
      eventId: `master:${m.kind}:${m.key}:${m.version}`,
      direction: "inbound",
      kind: m.kind,
      payload: m,
    });
    if (received.quarantined) return received;
    if (received.duplicate) {
      const [event] =
        await t`select status from integration_events where id=${received.id}`;
      if (event.status !== "pending") return received;
    }
    try {
      await tx(t, async (s) => storeReplica(s, m));
      await t`update integration_events set status='completed',processed_at=now() where id=${received.id}`;
      await resolution(t, received.id, "replicated", {
        kind: m.kind,
        version: m.version,
      });
    } catch (e) {
      const category = e instanceof SapFailure ? e.category : "contract";
      await t`update integration_events set status='dead_letter',error_class=${category},last_error=${`Master ${category}; review the SAP source record`} where id=${received.id}`;
      await resolution(t, received.id, "dead_letter", { category });
    }
    return received;
  });
}
/** @param {any} db @param {Record<string,string|undefined>} [env] */
export async function syncMasters(db, env) {
  let received = 0;
  for (const kind of masterKinds) {
    const [cursor] =
      await db`select cursor from sap_feed_cursors where kind=${kind}`;
    let after = cursor?.cursor ?? "0";
    for (let i = 0; i < 100; i++) {
      const page = await sapRequest(
        db,
        `/v1/masters/${kind}?after=${encodeURIComponent(after)}`,
        { schema: "masterPage", env },
      );
      if (page.items.some((/** @type {any} */ m) => m.kind !== kind))
        throw new SapFailure("contract", false);
      await tx(db, async (t) => {
        // F-004 one atomic feed page, including receipts, deltas and watermark.
        // Avoid one fsync per master while preserving per-record rejection savepoints.
        for (const m of page.items) {
          await ingestMaster(t, m);
          received++;
        }
        await t`insert into sap_feed_cursors(kind,cursor,last_success_at) values(${kind},${page.watermark},now()) on conflict(kind) do update set cursor=excluded.cursor,last_success_at=now()`;
      });
      if (!page.nextCursor) break;
      if (page.nextCursor === after) throw new SapFailure("contract", false);
      after = page.nextCursor;
    }
  }
  return received;
}
/** F-015 future-dated updates become current without another SAP delivery. @param {any} db */
export async function activateMasters(db) {
  await tx(db, async (t) => {
    const rows =
      await t`select distinct on(kind,sap_key) * from sap_replicas where effective_from<=now() order by kind,sap_key,sap_version desc`;
    for (const r of rows) {
      const expired = Boolean(
        r.deleted_at ||
        (r.effective_to && new Date(r.effective_to).getTime() <= Date.now()),
      );
      const [old] =
        await t`select * from sap_master_publications where id=${r.master_id} for update`;
      if (old?.replica_id === r.id && old.expired === expired) {
        if (["stock", "location"].includes(r.kind))
          await materialize(t, {
            ...r,
            deleted_at: expired ? new Date() : null,
          });
        continue;
      }
      await materialize(t, { ...r, deleted_at: expired ? new Date() : null });
      await t`insert into sap_master_publications(id,replica_id,expired) values(${r.master_id},${r.id},${expired}) on conflict(id) do update set replica_id=excluded.replica_id,expired=excluded.expired,updated_at=now()`;
      await recordChange(t, {
        entity: "sap.master",
        entityId: r.master_id,
        scopeKey: "sap:masters",
        op: expired ? "tombstone" : "upsert",
      });
    }
  });
}
/** F-016 price authority with customer > channel > base and explicit SAP precedence.
 * @param {any} db @param {any} q
 */
export async function resolveSapPrice(db, q) {
  const rows =
    await db`select r.*,p.id as product_id from (select distinct on(sap_key) * from sap_replicas where kind='condition' and organization_id=${q.organizationId} and effective_from<=${new Date(q.at)} order by sap_key,sap_version desc) r
    join products p on p.code=r.payload->'data'->>'productCode' where p.id=${q.productId} and r.deleted_at is null and (r.effective_to is null or r.effective_to>${new Date(q.at)}) and r.payload->'data'->>'uom'=${q.uom}`;
  const eligible = rows.filter((/** @type {any} */ r) => {
    const d = r.payload.data;
    return (
      (!d.customerCode || d.customerCode === q.customerCode) &&
      (!d.channelKey || d.channelKey === q.channelKey)
    );
  });
  const rank = (/** @type {any} */ r) => [
    r.payload.data.customerCode ? 2 : r.payload.data.channelKey ? 1 : 0,
    r.payload.data.precedence,
  ];
  eligible.sort(
    (/** @type {any} */ a, /** @type {any} */ b) =>
      rank(b)[0] - rank(a)[0] || rank(b)[1] - rank(a)[1],
  );
  const first = eligible[0];
  if (
    !first ||
    (eligible[1] && rank(first).join("|") === rank(eligible[1]).join("|"))
  )
    return {
      unitPriceCentavos: null,
      priceListId: null,
      source: first ? "ambiguous" : "missing",
    };
  return quoteSapCondition(first);
}
/** F-016 F-307: one quote validator for SAP replicas and approved marked mock conditions.
 * Account hierarchy selects the condition; it cannot implement a second pricing engine.
 * @param {any} first
 * @returns {{unitPriceCentavos:number|null,priceListId:any,source:string,taxCode?:string,taxBasisPoints?:number,taxInclusive?:boolean,sapKey?:string,sapVersion?:number,effectiveFrom?:number,effectiveTo?:number|null}} */
export function quoteSapCondition(first) {
  const d = first.payload.data;
  if (!Number.isSafeInteger(d.unitPriceCentavos) || d.unitPriceCentavos < 0)
    return {
      unitPriceCentavos: null,
      priceListId: null,
      source: "invalid_condition",
    };
  if (!d.taxInclusive && d.taxBasisPoints > 0)
    return {
      unitPriceCentavos: null,
      priceListId: null,
      source: "sap_tax_quote_required",
    };
  return {
    unitPriceCentavos: d.unitPriceCentavos,
    priceListId: first.price_list_id ?? null,
    source: first.source === "sample" ? "sap_sample" : "sap",
    taxCode: d.taxCode,
    taxBasisPoints: d.taxBasisPoints,
    taxInclusive: d.taxInclusive,
    sapKey: first.sap_key,
    sapVersion: Number(first.sap_version),
    effectiveFrom: new Date(first.effective_from).getTime(),
    effectiveTo: first.effective_to
      ? new Date(first.effective_to).getTime()
      : null,
  };
}
