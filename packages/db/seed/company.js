import catalog from "./catalog.json" with { type: "json" };
import { ACTOR, ORGANIZATION as org, at, plusDays, rowId } from "./store.js";

export const CHANNELS = ["gt", "pmot", "supermarket", "kas"];
export const TERRITORIES = [
  { name: "Mandaue-Consolacion", lat: 10.351, lng: 123.949 },
  { name: "Cebu City North", lat: 10.331, lng: 123.908 },
  { name: "Cebu City South", lat: 10.299, lng: 123.884 },
  { name: "Talisay-Minglanilla", lat: 10.255, lng: 123.839 },
];
const POSITIONS = [
  ["SCDM", "Sales Manager", "leadership", null, null, null],
  ["SR_CDS", "Sr Channel Development Specialist", "supervisory", null, 1, 4],
  ["CDS", "Channel Development Specialist", "supervisory", null, 3, 12],
  ["DS", "Distributor Specialist", "specialist", null, 4, 16],
  ["KAS", "Key Account Specialist", "field", 5, null, null],
  ["PMOT", "Public Market and Open Trade", "field", 30, null, null],
  ["PMOT_EXTRUCK", "PMOT Extruck", "field", 30, null, null],
];

/** Restricted-circulation sample EAN-13, not a real manufacturer's registered code.
 * @param {number} index */
function barcode(index) {
  const body = `299${String(index).padStart(9, "0")}`;
  const sum = [...body].reduce(
    (total, digit, i) => total + Number(digit) * (i % 2 ? 3 : 1),
    0,
  );
  return body + String((10 - (sum % 10)) % 10);
}

/** Construct only owned rows. Existing real accounts/codes are never adopted or overwritten.
 * @param {import('./store.js').Dataset} d @param {string[]} hashes */
export function company(d, hashes) {
  const root = d.add("org_units", "national", {
    organization_id: org,
    code: "SUNPRIDE",
    name: "Sunpride Demo Philippines",
    type_code: "national",
    status: "active",
    effective_from: d.epoch,
  });
  const region = d.add("org_units", "visayas", {
    organization_id: org,
    code: "SMP-VIS",
    name: "Sample Visayas",
    type_code: "region",
    parent_id: root.id,
    status: "active",
    effective_from: d.epoch,
  });
  for (const [i, code] of ["national", "region", "territory"].entries())
    d.add("org_unit_types", code, {
      organization_id: org,
      code,
      label: code,
      level: i,
      active: true,
    });
  const units = TERRITORIES.map((t, i) =>
    d.add("org_units", `territory-${i}`, {
      organization_id: org,
      code: `SMP-T${i + 1}`,
      name: `Sample ${t.name}`,
      type_code: "territory",
      parent_id: region.id,
      status: "active",
      effective_from: d.epoch,
    }),
  );
  for (const unit of [region, ...units])
    d.add("org_unit_parent_edges", unit.id, {
      unit_id: unit.id,
      parent_id: unit.parent_id,
      effective_from: d.epoch,
      actor_subject: ACTOR,
      reason: "Sample organization",
    });
  /** @type {Record<string, import('./store.js').Row>} */
  const positions = {};
  for (const [code, label, category, calls, weekly, monthly] of POSITIONS) {
    const p = d.add("positions", String(code), {
      organization_id: org,
      code,
      label,
      category,
      active: true,
    });
    positions[String(code)] = p;
    if (calls || weekly)
      d.add("position_standards", String(code), {
        organization_id: org,
        position_id: p.id,
        effective_from: d.epoch,
        daily_calls_target: calls,
        productive_call_target_pct: calls ? (code === "KAS" ? 90 : 85) : null,
        work_with_weekly_min: weekly,
        work_with_monthly_min: monthly,
        productive_call_rule: calls
          ? code === "KAS"
            ? "any_listed_activity"
            : "truck_seller"
          : "any_listed_activity",
        selling_weekdays: [1, 2, 3, 4, 5, 6],
        notes:
          code === "KAS"
            ? "Sample. KAS productivity remains disputed: email 85%, memo 90%; provisional 90% retained."
            : "Sample workload; memo Work-With and call standards retained separately.",
        source_ref: calls
          ? "Sir Francis email 2026-09-30 / call 2026-10-02"
          : "memo 2026-01-20 §III",
      });
  }
  /** @type {Record<string, import('./store.js').Row>} */
  const people = {};
  const accounts = [
    ["admin", "admin", "Sample Admin", root, "SCDM"],
    ["manager", "manager", "Sample Maria Sales Manager", region, "SCDM"],
    ["supervisor", "manager", "Sample Elena Supervisor", units[0], "CDS"],
    ["agent", "sales", "Sample Ana Mercado", units[0], "DS"],
    ["van", "sales", "Sample Paolo Van Seller", units[1], "PMOT"],
    ["approver", "approver", "Sample Finance Approver", root, "SCDM"],
    ["viewer", "viewer", "Sample Owner Viewer", root, "SCDM"],
  ];
  for (const [i, account] of accounts.entries()) {
    const [key, role, name, unit, position] =
      /** @type {[string,string,string,import('./store.js').Row,string]} */ (
        account
      );
    const user = d.add("users", key, {
      email: `${key}@sunpride.test`,
      password_hash: hashes[i],
    });
    people[key] = d.add("profiles", key, {
      user_id: user.id,
      auth_subject: user.id,
      name,
      email: user.email,
      role,
      status: "active",
      org_unit_id: unit.id,
      employee_code: `SMP-${key.toUpperCase()}`,
      position_id: positions[position].id,
      employment_type: "sfi_employee",
      channel_scope: key === "van" ? "pmot" : "gt",
      effective_from: d.epoch,
    });
  }
  const supervisor2 = d.add("profiles", "supervisor-2", {
    auth_subject: "sample:supervisor-2",
    name: "Sample Tomas Supervisor",
    email: "sup2@sunpride.test",
    role: "manager",
    status: "active",
    org_unit_id: region.id,
    employee_code: "SMP-SUP2",
    position_id: positions.CDS.id,
    employment_type: "sfi_employee",
    effective_from: d.epoch,
  });
  const supervisors = [people.supervisor, supervisor2];
  const agentNames = [
    "Ana Mercado",
    "Ben Flores",
    "Carla Tan",
    "Dario Cruz",
    "Paolo Van Seller",
    "Faye Lim",
    "Grace Yu",
    "Hector Ramos",
    "Iris Ong",
    "Joel Dela Cruz",
    "Kaye Abad",
    "Luis Santos",
  ];
  const agentPositions = [
    "DS",
    "CDS",
    "KAS",
    "SR_CDS",
    "PMOT",
    "DS",
    "CDS",
    "PMOT_EXTRUCK",
    "KAS",
    "SR_CDS",
    "DS",
    "PMOT",
  ];
  /** @type {(import("./store.js").Row & {index:number,territoryIndex:number,positionCode:string,dailyCalls:number,compliance:number})[]} */
  const agents = agentNames.map((name, i) => {
    const p =
      i === 0
        ? people.agent
        : i === 4
          ? people.van
          : d.add("profiles", `agent-${i}`, {
              auth_subject: `sample:agent-${i}`,
              name: `Sample ${name}`,
              email: `field${i + 1}@sunpride.test`,
              role: "sales",
              status: "active",
              org_unit_id: units[Math.floor(i / 3)].id,
              employee_code: `SMP-F${i + 1}`,
              position_id: positions[agentPositions[i]].id,
              employment_type: "sfi_employee",
              channel_scope:
                agentPositions[i] === "KAS"
                  ? "kas"
                  : agentPositions[i].startsWith("PMOT")
                    ? "pmot"
                    : "gt",
              effective_from: d.epoch,
            });
    p.supervisor_subject = supervisors[Math.floor(i / 6)].auth_subject;
    return {
      ...p,
      index: i,
      territoryIndex: Math.floor(i / 3),
      positionCode: agentPositions[i],
      dailyCalls: agentPositions[i] === "KAS" ? 5 : [25, 28, 30][i % 3],
      compliance:
        i >= 9 ? 0.7 : i === 0 ? 0.98 : [1, 6].includes(i) ? 0.76 : 0.94,
    };
  });
  // Profiles' stored current projection and effective assignment history agree.
  for (const p of d.rows("profiles"))
    d.add("employee_assignments", p.id, {
      profile_id: p.id,
      org_unit_id: p.org_unit_id,
      role: p.role,
      position_id: p.position_id,
      supervisor_id:
        p.role === "sales"
          ? supervisors[
              (agents.find((a) => a.id === p.id)?.index ?? 0) < 6 ? 0 : 1
            ].id
          : p.id === people.manager.id
            ? null
            : people.manager.id,
      effective_from: d.epoch,
      actor_subject: ACTOR,
      reason: "Sample assignment",
    });
  const teams = units.map((u, i) =>
    d.add("teams", `territory-${i}`, {
      code: `SMP-TEAM-${i}`,
      name: `Sample ${TERRITORIES[i].name} team`,
      org_unit_id: u.id,
      status: "active",
      supervisor_profile_id: supervisors[Math.floor(i / 2)].id,
      effective_from: d.epoch,
      created_by: ACTOR,
    }),
  );
  for (const a of agents)
    d.add("team_memberships", a.id, {
      team_id: teams[a.territoryIndex].id,
      profile_id: a.id,
      effective_from: d.epoch,
      actor_subject: ACTOR,
      reason: "Sample membership",
    });
  const targetTeams = ["company", ...CHANNELS].map((key) =>
    d.add("teams", `target-${key}`, {
      code: `SMP-TARGET-${key.toUpperCase()}`,
      name: `Sample target aggregation: ${key}`,
      org_unit_id: root.id,
      status: "active",
      effective_from: d.epoch,
      created_by: ACTOR,
    }),
  );
  d.add("access_invitations", "owner", {
    email: "jcing.jc@gmail.com",
    name: "JC",
    role: "super_admin",
    status: "pending",
    invited_by: ACTOR,
    invited_at: d.epoch,
  });
  const territories = units.map((u, i) => {
    const t = d.add("territories", String(i), {
      organization_id: org,
      code: `SMP-T${i + 1}`,
      name: TERRITORIES[i].name,
      status: "active",
      effective_from: d.epoch,
      created_by: ACTOR,
    });
    d.add("territory_ownerships", String(i), {
      territory_id: t.id,
      org_unit_id: u.id,
      effective_from: d.epoch,
      actor_subject: ACTOR,
      reason: "Sample ownership",
    });
    return t;
  });
  const routes = agents.map((a, i) => {
    const r = d.add("routes", String(i), {
      organization_id: org,
      code: `SMP-R${i + 1}`,
      name: `Sample ${TERRITORIES[a.territoryIndex].name} route ${(i % 3) + 1}`,
      status: "active",
      effective_from: d.epoch,
      weekday_template: [1, 2, 3, 4, 5, 6],
      created_by: ACTOR,
    });
    d.add("route_territories", String(i), {
      route_id: r.id,
      territory_id: territories[a.territoryIndex].id,
      effective_from: d.epoch,
      actor_subject: ACTOR,
      reason: "Sample route",
    });
    d.add("route_salespeople", String(i), {
      route_id: r.id,
      profile_id: a.id,
      is_primary: true,
      effective_from: d.epoch,
      actor_subject: ACTOR,
      reason: "Sample assignment",
    });
    d.add("territory_salespeople", String(i), {
      territory_id: territories[a.territoryIndex].id,
      profile_id: a.id,
      kind: "primary",
      effective_from: d.epoch,
      actor_subject: ACTOR,
      reason: "Sample assignment",
    });
    return r;
  });
  const uoms = ["PC", "CASE"].map((code) =>
    d.add("units_of_measure", code, {
      organization_id: org,
      code,
      name: code === "PC" ? "Piece" : "Case",
      dimension: "count",
      decimal_places: 0,
      active: true,
    }),
  );
  const products = catalog.map((p, i) => {
    const product = d.add("products", p.code, {
      code: p.code,
      name: `Sample ${p.name}`,
      category: p.category,
      uom: "PC",
      unit_price: p.piecePriceMinor / 100,
      active: true,
      organization_id: org,
      base_uom_id: uoms[0].id,
      quantity_scale: 1,
      tracking_mode: "lot",
      allocation_policy: "fefo",
      policy_version: 1,
      catalog_source: "sample",
      catalog_updated_at: d.epoch,
    });
    for (const [ordinal, uom] of uoms.entries()) {
      d.add("product_selling_uoms", `${i}-${ordinal}`, {
        product_id: product.id,
        ordinal,
        uom_id: uom.id,
      });
      d.add("product_barcodes", `${i}-${ordinal}`, {
        organization_id: org,
        product_id: product.id,
        barcode: barcode(i * 2 + ordinal),
        uom_id: uom.id,
        active: true,
        source: "sample",
      });
    }
    d.add("uom_conversions", String(i), {
      organization_id: org,
      product_id: product.id,
      from_uom_id: uoms[1].id,
      to_uom_id: uoms[0].id,
      numerator: p.caseQty,
      denominator: 1,
      rounding_mode: "exact",
      effective_from: d.epoch,
      active: true,
    });
    return {
      ...product,
      ...p,
      id: product.id,
      cost: Math.round(p.piecePriceMinor * 0.65),
      index: i,
    };
  });
  const factors = [1, 1.03, 0.98, 0.96];
  const lists = [...CHANNELS, null].map((channel, i) => {
    const key = channel ?? "default";
    const list = d.add("price_lists", key, {
      organization_id: org,
      code: `SMP-${key.toUpperCase()}`,
      name: `Sample ${key} prices`,
      channel_key: channel,
      currency: "PHP",
      status: "active",
      source: "sample",
      effective_from: d.epoch,
    });
    for (const p of products)
      for (const uom of ["PC", "CASE"])
        d.add("price_list_lines", `${key}-${p.code}-${uom}`, {
          organization_id: org,
          price_list_id: list.id,
          product_id: p.id,
          uom,
          unit_price_minor:
            Math.round(p.piecePriceMinor * (factors[i] ?? 1)) *
            (uom === "CASE" ? p.caseQty : 1),
          effective_from: d.epoch,
        });
    return list;
  });
  for (let i = 0; i < 3; i++)
    d.add("promotions", String(i), {
      organization_id: org,
      code: `SMP-PROMO-${i + 1}`,
      name: [
        "Sample Payday canned offer",
        "Sample Frozen introduction",
        "Sample Mixes display offer",
      ][i],
      price_list_id: lists[i].id,
      rule_kind: "percent_off",
      rule: {
        kind: "percent_off",
        item: {
          productId: products.find(
            (p) => p.category === ["Canned", "Frozen", "Mixes"][i],
          )?.id,
          uom: "CASE",
          quantity: 1,
        },
        percentOffBasisPoints: 500,
      },
      status: "active",
      source: "sample",
      effective_from: d.epoch,
      effective_to: new Date(at(plusDays(d.anchorDate, 30))).toISOString(),
    });
  const storeNames = [
    "Aling Nena",
    "Suking Tindahan",
    "Luz",
    "Jun Jun",
    "Santos",
    "Dela Cruz",
    "Rosita",
    "Bayanihan",
    "Mercado",
    "San Roque",
    "Lourdes",
    "Mabuhay",
  ];
  /** @type {(import("./store.js").Row & {customer:import("./store.js").Row,pin:import("./store.js").Row,lat:number,lng:number,territoryIndex:number,agentIndex:number,route:import("./store.js").Row,index:number,dormant:boolean})[]} */
  const stores = Array.from({ length: 300 }, (_, i) => {
    const ti = Math.floor(i / 75),
      local = i % 75,
      ai = ti * 3 + (local % 3);
    const channel =
      i % 20 < 12
        ? "gt"
        : i % 20 < 15
          ? "pmot"
          : i % 20 < 18
            ? "supermarket"
            : "kas";
    const name = `Sample ${storeNames[i % storeNames.length]} ${channel === "gt" ? "Sari-sari" : channel === "pmot" ? "Market Stall" : channel === "kas" ? "Key Account" : "Supermart"} ${i + 1}`;
    const customer = d.add("customers", String(i), {
      code: `SMP-C${String(i + 1).padStart(4, "0")}`,
      name,
      channel,
      territory: territories[ti].code,
      credit_limit: ["kas", "supermarket"].includes(channel)
        ? 250_000 + (i % 4) * 50_000
        : 0,
      active: true,
    });
    const outlet = d.add("outlets", String(i), {
      organization_id: org,
      // SP-0170: Customer = store, one Customer Code for the store and its accounting row.
      code: customer.code,
      name,
      status: "active",
      custodian_org_unit_id: units[ti].id,
      channel,
      address: `Sample address, ${TERRITORIES[ti].name}, Cebu`,
      enrolment_status: "approved",
      created_by: ACTOR,
      visit_frequency_days: 6,
    });
    const lat = TERRITORIES[ti].lat + (d.rng() - 0.5) * 0.022,
      lng = TERRITORIES[ti].lng + (d.rng() - 0.5) * 0.018;
    const pin = d.add("outlet_pins", String(i), {
      outlet_id: outlet.id,
      latitude: lat,
      longitude: lng,
      radius_meters: 75,
      source: "sample",
      evidence_note: "Synthetic Cebu coordinate, not a real customer address",
      status: "verified",
      effective_from: d.epoch,
      proposed_by: people.admin.auth_subject,
      proposed_at: d.epoch,
      verified_by: people.manager.auth_subject,
      verified_at: d.epoch,
    });
    d.add("outlet_customer_links", String(i), {
      outlet_id: outlet.id,
      customer_id: customer.id,
      source: "sample",
      effective_from: d.epoch,
      actor_subject: ACTOR,
      reason: "Sample accounting customer",
    });
    d.add("outlet_assignments", String(i), {
      outlet_id: outlet.id,
      territory_id: territories[ti].id,
      route_id: routes[ai].id,
      sequence: Math.floor(local / 3) + 1,
      effective_from: d.epoch,
      actor_subject: ACTOR,
      reason: "Sample route stop",
    });
    d.add("sales_assignments", String(i), {
      salesperson_subject: agents[ai].auth_subject,
      customer_code: customer.code,
      territory: territories[ti].code,
      active: true,
    });
    if (["kas", "supermarket"].includes(channel))
      d.add("outlet_credit_terms", String(i), {
        organization_id: org,
        outlet_id: outlet.id,
        terms_days: 30,
        credit_limit_minor: customer.credit_limit * 100,
        currency: "PHP",
        effective_from: d.epoch,
        source_ref: "sample",
        actor_subject: ACTOR,
      });
    return {
      ...outlet,
      customer,
      pin,
      lat,
      lng,
      territoryIndex: ti,
      agentIndex: ai,
      route: routes[ai],
      index: i,
      dormant: i % 25 === 0,
    };
  });
  const pending = d.add(
    "outlets",
    "pending",
    {
      organization_id: org,
      code: "SMP-PENDING-001",
      name: "Sample Cebu New Store — approval needed",
      status: "prospect",
      custodian_org_unit_id: units[0].id,
      channel: "gt",
      enrolment_status: "provisional",
      created_by: people.agent.auth_subject,
    },
    d.noon,
  );
  const pendingPin = d.add(
    "outlet_pins",
    "pending",
    {
      outlet_id: pending.id,
      latitude: 10.354,
      longitude: 123.947,
      radius_meters: 75,
      source: "sample",
      evidence_note:
        "Sample enrolment; office must collect a real CIS/photo before real approval",
      status: "pending",
      effective_from: d.noon,
      proposed_by: people.agent.auth_subject,
      proposed_at: d.noon,
    },
    d.noon,
  );
  d.add(
    "outlet_enrolments",
    "pending",
    {
      organization_id: org,
      outlet_id: pending.id,
      org_unit_id: units[0].id,
      territory_id: territories[0].id,
      pin_id: pendingPin.id,
      status: "pending",
      provisional_code: pending.code,
      client_request_id: "sample-new-store",
      proposed_by: people.agent.auth_subject,
      proposed_by_profile_id: people.agent.id,
      proposed_at: d.noon,
    },
    d.noon,
  );
  return {
    root,
    region,
    units,
    positions,
    people,
    supervisors,
    agents,
    teams,
    targetTeams,
    territories,
    routes,
    uoms,
    products,
    lists,
    factors,
    stores,
  };
}
/** @typedef {ReturnType<typeof company>} Company */
