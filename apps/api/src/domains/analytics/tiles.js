/** Re-slice an already authorized source projection without another SQL scan.
 * @param {any} data @param {any} p @param {string} [group] */
export function sliceTiles(data, p, group = "channel") {
  const rows = data.agentDays.filter((/** @type {any} */ r) => {
    const d = new Date(r.service_date).toISOString().slice(0, 10);
    return d >= p.from && d <= p.to;
  });
  const empty = (/** @type {string} */ key, /** @type {string} */ label) => ({
    key,
    label,
    sales: 0,
    approved: 0,
    posted: 0,
    orders: 0,
    lines: 0,
    quantity: 0,
    buyers: new Set(),
    stores: new Set(),
  });
  const add = (/** @type {any} */ a, /** @type {any} */ r) => {
    for (const k of [
      "sales",
      "approved",
      "posted",
      "orders",
      "lines",
      "quantity",
    ])
      a[k] += Number(r[k]);
    for (const b of r.buyers) a.buyers.add(b);
    for (const st of r.stores) a.stores.add(st);
  };
  const total = empty("total", "Total"),
    days = new Map(),
    groups = new Map();
  for (const r of rows) {
    const d = new Date(r.service_date).toISOString().slice(0, 10),
      key = group === "agent" ? r.group_key : r.channel,
      label = group === "agent" ? r.label : r.channel;
    add(total, r);
    if (!days.has(d)) days.set(d, empty(d, d));
    add(days.get(d), r);
    if (!groups.has(key)) groups.set(key, empty(key, label));
    add(groups.get(key), r);
  }
  const finish = (/** @type {any} */ r) => ({
    ...r,
    ubo: r.buyers.size,
    buyers: [...r.buyers],
    stores: r.stores.size,
  });
  return {
    total: finish(total),
    days: [...days.values()].map(finish),
    rows: [...groups.values()].map(finish),
  };
}

/** Compact management read path; the caller has verified all source/master revisions.
 * @param {any} db @param {any} p @param {any} s @param {string} group @param {string|null} parent */
export async function readTiles(db, p, s, group, parent) {
  const parts = parent?.split(":"),
    parentKind = parts?.[0],
    parentKey = parts?.slice(1).join(":");
  const baseKind = parentKind === "store" ? "store" : "agent";
  const rows =
    await db`with selected as materialized(select group_kind,group_key,label,service_date,sales,approved,posted,orders,lines,quantity,buyers,stores,channel
    from analytics_sales_tiles where service_date between ${p.from} and ${p.to}
    and group_kind in ${db([...new Set([baseKind, group])])}
    and agent_unit_id in ${db(s.ids.length ? s.ids : [null])}
    and (owner_unit_id in ${db(s.ids.length ? s.ids : [null])} or (owner_unit_id is null and ${s.cross}))
    and (source_location_id is null or source_unit_id in ${db(s.ids.length ? s.ids : [null])})
    and (${p.channel}::text is null or channel=${p.channel}) and (${s.ownProfileId}::uuid is null or profile_id=${s.ownProfileId})
    and (${parentKind ?? null}::text is null or (${parentKind ?? null}='channel' and channel=${parentKey ?? null}) or (${parentKind ?? null}='territory' and territory_id::text=${parentKey ?? null}) or (${parentKind ?? null}='agent' and profile_id::text=${parentKey ?? null}) or (${parentKind ?? null}='store' and group_kind='store' and group_key=${parentKey ?? null})))
    select group_kind,group_key,label,service_date,sales,approved,posted,orders,lines,quantity,to_jsonb(buyers) as buyers,to_jsonb(stores) as stores,false as nested,channel from selected where group_kind=${baseKind}
    union all select group_kind,group_key,label,null,sum(sales),sum(approved),sum(posted),sum(orders),sum(lines),sum(quantity),jsonb_agg(buyers),jsonb_agg(stores),true,null::text from selected where group_kind=${group} and group_kind!=${baseKind} group by group_kind,group_key,label`;
  /** @param {string} key @param {string} label */
  const empty = (key, label) => ({
    key,
    label,
    sales: 0,
    approved: 0,
    posted: 0,
    orders: 0,
    lines: 0,
    quantity: 0,
    buyerSet: new Set(),
    storeSet: new Set(),
  });
  /** @param {any} a @param {any} r */
  const add = (a, r) => {
    for (const k of [
      "sales",
      "approved",
      "posted",
      "orders",
      "lines",
      "quantity",
    ])
      a[k] += Number(r[k]);
    for (const b of r.buyers) a.buyerSet.add(b);
    for (const st of r.stores) a.storeSet.add(st);
  };
  const total = empty("total", "Total"),
    days = new Map(),
    groups = new Map();
  for (const r of rows) {
    if (r.nested) {
      r.buyers = r.buyers.flat();
      r.stores = r.stores.flat();
    }
    if (r.group_kind === baseKind) {
      add(total, r);
      const date = new Date(r.service_date).toISOString().slice(0, 10);
      if (!days.has(date)) days.set(date, empty(date, date));
      add(days.get(date), r);
    }
    if (r.group_kind === group) {
      if (!groups.has(r.group_key))
        groups.set(r.group_key, empty(r.group_key, r.label));
      add(groups.get(r.group_key), r);
    }
  }
  /** @param {any} r */
  const finish = (r) => {
    const { buyerSet, storeSet, ...rest } = r;
    return {
      ...rest,
      ubo: buyerSet.size,
      stores: storeSet.size,
      buyers: [...buyerSet],
    };
  };
  return {
    total: finish(total),
    days: [...days.values()].map(finish),
    rows: [...groups.values()].map(finish),
    agentDays: rows.filter((/** @type {any} */ r) => r.group_kind === "agent"),
  };
}
