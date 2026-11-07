import { nextDocNumber } from "../../core/docnum.js";
import { refuse, dayString } from "../van/model.js";
import { expectedCash, slipCode } from "./cash.js";

/** Grand totals wrap here (centavos) and the reset counter goes up, like the BIR accumulated sales counter. */
export const RESET_LIMIT = 10n ** 16n;
export const PRIVILEGE_TYPES = [
  "senior",
  "pwd",
  "solo_parent",
  "athlete",
  "uniformed",
];
const PRIVILEGE_LABEL = /** @type {Record<string,string>} */ ({
  senior: "Senior citizen discount (20%)",
  pwd: "PWD discount (20%)",
  solo_parent: "Solo parent discount (10%)",
  athlete: "Athlete discount (20%)",
  uniformed: "Uniformed personnel discount (10%)",
});
const big = (/** @type {any} */ v) => BigInt(v ?? 0);
const str = (/** @type {bigint} */ v) => String(v);

/**
 * Privilege discount carried by a frozen sale receipt. Contract with lane BIR (they write the receipt):
 * `receipt.privilege = { byType: { senior: { discountMinor, vatRemovedMinor }, pwd: {...}, ... } }`
 * (a single `{ type, discountMinor, vatRemovedMinor }` is also accepted). A receipt without it has no privilege discount.
 * @param {any} receipt
 */
export function privilegeOf(receipt) {
  /** @type {Record<string,bigint>} */ const byType = {};
  for (const t of PRIVILEGE_TYPES) byType[t] = 0n;
  let vatRemoved = 0n;
  const pr = receipt?.privilege;
  if (!pr) return { byType, vatRemoved };
  /** @type {[string, any][]} */
  const entries = pr.byType
    ? Object.entries(pr.byType)
    : pr.type
      ? [[pr.type, pr]]
      : [];
  for (const [type, v] of entries) {
    if (!(type in byType)) continue;
    byType[type] += big(v?.discountMinor);
    vatRemoved += big(v?.vatRemovedMinor);
  }
  return { byType, vatRemoved };
}

/**
 * Pure: the sales half of a reading from frozen receipts. Voided sales are out of sales and counted as voids.
 * Refunds (credit memos) are listed separately and never reduce the grand totals.
 * @param {{number:string, status:string, receipt:any}[]} sales
 * @param {{number:string, amount:string}[]} credits
 */
export function aggregateSales(sales, credits) {
  /** @type {Record<string,bigint>} */ const privilege = {};
  for (const t of PRIVILEGE_TYPES) privilege[t] = 0n;
  let net = 0n,
    promo = 0n,
    vatRemoved = 0n,
    vatable = 0n,
    vat = 0n,
    exempt = 0n,
    zero = 0n,
    count = 0,
    voidTotal = 0n;
  /** @type {string[]} */ const numbers = [];
  /** @type {string[]} */ const voidNumbers = [];
  for (const s of sales) {
    const total = big(s.receipt?.totalMinor);
    if (s.status === "voided") {
      voidTotal += total;
      voidNumbers.push(s.number);
      continue;
    }
    count++;
    numbers.push(s.number);
    net += total;
    // IP-INT2: on a privilege sale `discountCentavos` is gross - payable (it already holds the privilege discount and the VAT
    // removed), so the promo part is the line's own `promoDiscountCentavos` when the sale writes one.
    for (const l of s.receipt?.lines ?? [])
      promo += big(l.promoDiscountCentavos ?? l.discountCentavos);
    const pv = privilegeOf(s.receipt);
    for (const t of PRIVILEGE_TYPES) privilege[t] += pv.byType[t];
    vatRemoved += pv.vatRemoved;
    const tax = s.receipt?.tax ?? {};
    vatable += big(tax.vatableSalesMinor);
    vat += big(tax.vatMinor);
    exempt += big(tax.vatExemptMinor);
    zero += big(tax.zeroRatedMinor);
  }
  const privilegeTotal = PRIVILEGE_TYPES.reduce((n, t) => n + privilege[t], 0n);
  const gross = net + promo + privilegeTotal + vatRemoved;
  const refundTotal = credits.reduce((n, c) => n + big(c.amount), 0n);
  return {
    transactions: count,
    gross,
    promo,
    privilege,
    privilegeTotal,
    vatRemoved,
    net,
    vatable,
    vat,
    exempt,
    zero,
    firstNumber: numbers[0] ?? null,
    lastNumber: numbers.at(-1) ?? null,
    voids: {
      count: voidNumbers.length,
      total: voidTotal,
      first: voidNumbers[0] ?? null,
      last: voidNumbers.at(-1) ?? null,
    },
    refunds: {
      count: credits.length,
      total: refundTotal,
      first: credits[0]?.number ?? null,
      last: credits.at(-1)?.number ?? null,
    },
  };
}

/** Pure: the next accumulator row from the last one. @param {{reset_counter:number, ending_gross_centavos:any, ending_net_centavos:any, z_counter:any}|null} last @param {bigint} gross @param {bigint} net */
export function advanceAccumulator(last, gross, net) {
  const begGross = big(last?.ending_gross_centavos),
    begNet = big(last?.ending_net_centavos);
  let reset = last?.reset_counter ?? 0;
  let endGross = begGross + gross,
    endNet = begNet + net;
  if (endGross >= RESET_LIMIT || endNet >= RESET_LIMIT) {
    reset += 1;
    endGross %= RESET_LIMIT;
    endNet %= RESET_LIMIT;
  }
  return {
    zCounter: Number(last?.z_counter ?? 0) + 1,
    resetCounter: reset,
    beginningGross: begGross,
    endingGross: endGross,
    beginningNet: begNet,
    endingNet: endNet,
    wrapped: reset !== (last?.reset_counter ?? 0),
  };
}

/**
 * IP-INT2FIX: what a register with history had already sold before the first new Z. Gross and net come from the same
 * aggregation the Z uses, over every sale of a day dated before the day being closed (voided sales are out).
 * @param {any} db @param {string} registerId @param {string} dayId
 */
export async function computeOpening(db, registerId, dayId) {
  const [day] =
    await db`select business_date::text as d from store_till_days where id=${dayId}`;
  if (!day) return null;
  const rows =
    await db`select s.receipt_number as number,s.receipt,o.status from store_sales s join orders o on o.id=s.order_id join store_shifts h on h.id=s.shift_id left join store_till_days d on d.id=h.till_day_id where h.register_id=${registerId} and (d.id is null or (d.id<>${dayId} and d.business_date<${day.d}::date)) order by s.sold_at,s.id`;
  const agg = aggregateSales(rows, []);
  return {
    gross: agg.gross,
    net: agg.net,
    salesCount: agg.transactions,
    through: day.d,
  };
}

/**
 * The accumulator row the next Z continues from. A register with no accumulator row yet but with sales history starts
 * from an opening balance = everything it sold before the day being closed. The opening is written once (record=true,
 * only by the Z) into an append-only, audited row; a preview (X reading) computes the same number without writing.
 * @param {any} db @param {string} registerId @param {string|null} [dayId] @param {boolean} [record]
 */
export async function lastAccumulator(
  db,
  registerId,
  dayId = null,
  record = false,
) {
  const [row] =
    await db`select * from store_fiscal_accumulators where register_id=${registerId} order by z_counter desc limit 1`;
  const [seq] =
    await db`select next_number-1 as n from store_read_sequences where register_id=${registerId} and kind='z'`;
  // Legacy Z readings (before accumulators) advanced the read sequence; the Z counter continues from it.
  const legacy = Number(seq?.n ?? 0);
  if (row && Number(row.z_counter) >= legacy) return row;
  let gross = row?.ending_gross_centavos ?? 0,
    net = row?.ending_net_centavos ?? 0;
  if (!row && dayId) {
    const [open] =
      await db`select * from store_accumulator_openings where register_id=${registerId}`;
    if (open) {
      gross = open.opening_gross_centavos;
      net = open.opening_net_centavos;
    } else {
      const made = await computeOpening(db, registerId, dayId);
      if (made && made.salesCount > 0) {
        gross = made.gross;
        net = made.net;
        if (record)
          await db`insert into store_accumulator_openings(register_id,opening_gross_centavos,opening_net_centavos,sales_count,through_business_date,first_till_day_id,computed_by) values(${registerId},${String(made.gross)},${String(made.net)},${made.salesCount},${made.through},${dayId},nullif(current_setting('sunpride.actor',true),''))`;
      }
    }
  }
  return {
    z_counter: legacy,
    reset_counter: row?.reset_counter ?? 0,
    ending_gross_centavos: gross,
    ending_net_centavos: net,
  };
}
/**
 * The one reading model. X (any time, read-only) and Z (day end) print THIS, so they never disagree.
 * Money is a decimal string of centavos.
 * @param {any} db @param {string} dayId @param {"x"|"z"} kind @param {boolean} [record] true only from the Z: writes the opening row
 */
export async function readingModel(db, dayId, kind, record = false) {
  const [day] =
    await db`select d.*,r.name as register_name,r.terminal_code,r.id as rid,l.name as store_name from store_till_days d join store_registers r on r.id=d.register_id join inventory_locations l on l.id=r.location_id where d.id=${dayId}`;
  if (!day) refuse("Choose a till day", "not_found");
  const sessions =
    await db`select s.*,p.name as cashier_name,c.id as closure_id,c.declared_centavos,c.expected_centavos as closed_expected,c.variance_centavos,c.closed_at,c.kind as closure_kind,c.needs_review,d.decision,exists(select 1 from store_session_events e where e.shift_id=s.id and e.kind='suspended' and not exists(select 1 from store_session_events e2 where e2.shift_id=s.id and e2.kind='resumed' and e2.captured_at>e.captured_at)) as suspended from store_shifts s join profiles p on p.id=s.cashier_id left join store_shift_closures c on c.shift_id=s.id left join store_shift_decisions d on d.closure_id=c.id where s.till_day_id=${dayId} order by s.opened_at,s.id`;
  const salesRows =
    await db`select s.receipt_number as number,s.receipt,s.sold_at,o.status from store_sales s join orders o on o.id=s.order_id join store_shifts h on h.id=s.shift_id where h.till_day_id=${dayId} order by s.sold_at,s.id`;
  const wholeCredits =
    await db`select v.id,s.receipt,o.order_number as number,v.created_at as at from store_reversals v join store_sales s on s.id=v.sale_id join store_shifts h on h.id=v.shift_id left join orders o on o.id=v.order_id where h.till_day_id=${dayId} and v.status='approved' and v.kind='refund'`;
  // IP-REFUND: refunds of part of a sale (their own credit memo each). Whole-sale refunds stay on their old path.
  const partCredits =
    await db`select r.id,r.credit_number as number,r.original_number,r.total_centavos::text as amount,r.refunded_at as at from sale_refunds r join store_shifts h on h.id=r.shift_id where h.till_day_id=${dayId} and r.surface='store'`;
  /** @type {{number:string, amount:string, original:string, at:number}[]} */
  const creditRows = [
    ...wholeCredits.map((/** @type {any} */ c) => ({
      number: c.number,
      amount: String(c.receipt?.totalMinor ?? 0),
      original: c.receipt?.receiptNumber,
      at: +new Date(c.at),
    })),
    ...partCredits.map((/** @type {any} */ c) => ({
      number: c.number,
      amount: String(c.amount),
      original: c.original_number,
      at: +new Date(c.at),
    })),
  ].sort(
    (a, b) => a.at - b.at || String(a.number).localeCompare(String(b.number)),
  );
  const agg = aggregateSales(salesRows, creditRows);
  const tenderRows =
    await db`select t.method,max(t.label) as label,sum(t.amount_centavos)::text as amount from store_tenders t join store_shifts h on h.id=t.shift_id where h.till_day_id=${dayId} group by t.method order by t.method`;
  const tender = (/** @type {string} */ m) =>
    big(tenderRows.find((/** @type {any} */ t) => t.method === m)?.amount);
  const moves =
    await db`select kind,count(*)::int as n,coalesce(sum(amount_centavos),0)::text as total from store_cash_movements where till_day_id=${dayId} group by kind`;
  const move = (/** @type {string} */ k) =>
    big(moves.find((/** @type {any} */ m) => m.kind === k)?.total);
  const noSale = Number(
    moves.find((/** @type {any} */ m) => m.kind === "no_sale")?.n ?? 0,
  );

  let openingTotal = 0n,
    expectedTotal = 0n,
    countedTotal = 0n,
    countedExpected = 0n,
    anyCounted = false,
    forced = 0;
  const sessionViews = [];
  for (const s of sessions) {
    const sessionCash = await sessionCashParts(db, s.id);
    const expected = s.closure_id
      ? big(s.closed_expected)
      : await expectedCash(db, s.id);
    openingTotal += big(s.opening_centavos);
    expectedTotal += expected;
    const isForced = s.closure_kind === "forced";
    if (isForced) forced++;
    if (s.closure_id && !isForced) {
      anyCounted = true;
      countedTotal += big(s.declared_centavos);
      countedExpected += expected;
    }
    sessionViews.push({
      id: s.id,
      number: s.doc_number,
      cashier: s.cashier_name,
      openedAt: +new Date(s.opened_at),
      closedAt: s.closed_at ? +new Date(s.closed_at) : null,
      status: s.closure_id
        ? isForced
          ? "force_closed"
          : (s.decision ?? (s.needs_review ? "needs_review" : "closed"))
        : s.suspended
          ? "suspended"
          : "open",
      openingFloat: str(big(s.opening_centavos)),
      ...sessionCash,
      expected: str(expected),
      declared:
        s.closure_id && !isForced ? str(big(s.declared_centavos)) : null,
      variance:
        s.closure_id && !isForced ? str(big(s.variance_centavos)) : null,
      forced: isForced,
    });
  }
  // A finished day shows the numbers its Z froze; an open day shows what the Z would be.
  const [frozen] =
    day.status === "z_done"
      ? await db`select * from store_fiscal_accumulators where till_day_id=${dayId}`
      : [];
  const next = frozen
    ? {
        zCounter: Number(frozen.z_counter),
        resetCounter: frozen.reset_counter,
        beginningGross: big(frozen.beginning_gross_centavos),
        endingGross: big(frozen.ending_gross_centavos),
        beginningNet: big(frozen.beginning_net_centavos),
        endingNet: big(frozen.ending_net_centavos),
      }
    : advanceAccumulator(
        await lastAccumulator(db, day.register_id, dayId, record),
        agg.gross,
        agg.net,
      );
  /** @type {any[]} */
  const journal = salesRows.map((/** @type {any} */ s) => ({
    number: s.number,
    status: s.status,
    snapshot: s.receipt,
  }));
  for (const c of creditRows)
    journal.push({
      kind: "refund",
      number: c.number,
      original: c.original,
      amount: c.amount,
    });
  const model = {
    kind,
    dayId,
    docNumber: day.doc_number,
    status: day.status,
    businessDate: dayString(day.business_date),
    store: day.store_name,
    register: day.register_name,
    terminal: day.terminal_code,
    registerId: day.register_id,
    provisional: kind === "x",
    sessions: sessionViews,
    invoices: {
      beginning: agg.firstNumber,
      ending: agg.lastNumber,
      count: agg.transactions,
    },
    voids: {
      count: agg.voids.count,
      totalCentavos: str(agg.voids.total),
      beginning: agg.voids.first,
      ending: agg.voids.last,
    },
    refunds: {
      count: agg.refunds.count,
      totalCentavos: str(agg.refunds.total),
      beginning: agg.refunds.first,
      ending: agg.refunds.last,
    },
    sales: {
      grossCentavos: str(agg.gross),
      promoDiscountCentavos: str(agg.promo),
      privilegeDiscountCentavos: Object.fromEntries(
        PRIVILEGE_TYPES.map((t) => [t, str(agg.privilege[t])]),
      ),
      privilegeTotalCentavos: str(agg.privilegeTotal),
      vatRemovedCentavos: str(agg.vatRemoved),
      netCentavos: str(agg.net),
      netAfterReturnsCentavos: str(agg.net - agg.refunds.total),
      vatableCentavos: str(agg.vatable),
      vatCentavos: str(agg.vat),
      vatExemptCentavos: str(agg.exempt),
      zeroRatedCentavos: str(agg.zero),
      transactions: agg.transactions,
    },
    tenders: {
      cashCentavos: str(tender("cash")),
      gcashCentavos: str(tender("gcash")),
      cardCentavos: str(tender("card")),
      otherCentavos: str(
        tenderRows.reduce(
          (/** @type {bigint} */ n, /** @type {any} */ t) =>
            ["cash", "gcash", "card"].includes(t.method)
              ? n
              : n + big(t.amount),
          0n,
        ),
      ),
      list: tenderRows.map((/** @type {any} */ t) => ({
        method: t.method,
        label: t.label,
        amount: t.amount,
      })),
    },
    cash: {
      openingFloatCentavos: str(openingTotal),
      floatInCentavos: str(move("float")),
      paidInCentavos: str(move("paid_in")),
      dropsCentavos: str(move("drop")),
      pickupsCentavos: str(move("pickup")),
      paidOutCentavos: str(move("paid_out")),
      noSaleCount: noSale,
      expectedCentavos: str(expectedTotal),
      countedCentavos: anyCounted ? str(countedTotal) : null,
      shortOverCentavos: anyCounted
        ? str(countedTotal - countedExpected)
        : null,
      forcedSessions: forced,
    },
    accumulators: {
      zCounter: next.zCounter,
      resetCounter: next.resetCounter,
      beginningGrossCentavos: str(next.beginningGross),
      endingGrossCentavos: str(next.endingGross),
      beginningNetCentavos: str(next.beginningNet),
      endingNetCentavos: str(next.endingNet),
    },
    sample: salesRows.some((/** @type {any} */ s) => s.receipt?.fiscal?.sample),
    notice:
      "BIR reporting uses the configured fiscal authorization; sample series is not a filed PTU.",
    journal,
    generatedAt: Date.now(),
  };
  return { model, day, sessions, agg, next, salesRows, credits: creditRows };
}

/** @param {any} db @param {string} shiftId */
async function sessionCashParts(db, shiftId) {
  const [t] =
    await db`select coalesce(sum(amount_centavos) filter (where method='cash'),0)::text as cash from store_tenders where shift_id=${shiftId}`;
  const rows =
    await db`select kind,coalesce(sum(amount_centavos),0)::text as total from store_cash_movements where shift_id=${shiftId} group by kind`;
  const m = (/** @type {string} */ k) =>
    rows.find((/** @type {any} */ r) => r.kind === k)?.total ?? "0";
  return {
    cashSales: t.cash,
    floatIn: m("float"),
    paidIn: m("paid_in"),
    drops: m("drop"),
    pickups: m("pickup"),
    paidOut: m("paid_out"),
  };
}

/** 123456 -> "₱1,234.56", exact (BigInt), negative as "-₱0.50". @param {any} centavos */
export function pesoText(centavos) {
  if (centavos == null) return "—";
  const v = BigInt(centavos);
  const abs = v < 0n ? -v : v;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${v < 0n ? "-" : ""}₱${whole}.${(abs % 100n).toString().padStart(2, "0")}`;
}
/** Printer-neutral lines for X and Z. Same shape the handheld and web both render. @param {any} m */
export function readingPrintModel(m) {
  const peso = pesoText;
  /** @type {{label:string,value:string|null,strong?:boolean}[]} */
  const lines = [];
  const add = (
    /** @type {string} */ label,
    /** @type {any} */ value,
    strong = false,
  ) =>
    lines.push({ label, value: value == null ? null : String(value), strong });
  add("Store", m.store);
  add("Register", `${m.register} (${m.terminal})`);
  add("Business date", m.businessDate);
  if (m.kind === "z") {
    add("Z counter no.", m.accumulators.zCounter, true);
    add("Reset counter no.", m.accumulators.resetCounter);
  }
  add("Beginning invoice", m.invoices.beginning ?? "none");
  add("Ending invoice", m.invoices.ending ?? "none");
  add(
    "Void range",
    m.voids.count ? `${m.voids.beginning} – ${m.voids.ending}` : "none",
  );
  add(
    "Refund range",
    m.refunds.count ? `${m.refunds.beginning} – ${m.refunds.ending}` : "none",
  );
  add(
    "Beginning grand total (gross)",
    peso(m.accumulators.beginningGrossCentavos),
  );
  add("Ending grand total (gross)", peso(m.accumulators.endingGrossCentavos));
  add("Beginning grand total (net)", peso(m.accumulators.beginningNetCentavos));
  add("Ending grand total (net)", peso(m.accumulators.endingNetCentavos));
  add("Gross sales", peso(m.sales.grossCentavos), true);
  for (const t of PRIVILEGE_TYPES)
    add(PRIVILEGE_LABEL[t], peso(m.sales.privilegeDiscountCentavos[t]));
  add("VAT removed on privilege sales", peso(m.sales.vatRemovedCentavos));
  add("Other discounts", peso(m.sales.promoDiscountCentavos));
  add("Net sales", peso(m.sales.netCentavos), true);
  add("VATable sales", peso(m.sales.vatableCentavos));
  add("VAT", peso(m.sales.vatCentavos));
  add("VAT-exempt sales", peso(m.sales.vatExemptCentavos));
  add("Zero-rated sales", peso(m.sales.zeroRatedCentavos));
  add("Voids", `${m.voids.count} · ${pesoText(m.voids.totalCentavos)}`);
  add("Refunds", `${m.refunds.count} · ${pesoText(m.refunds.totalCentavos)}`);
  add("Cash", peso(m.tenders.cashCentavos));
  add("GCash", peso(m.tenders.gcashCentavos));
  add("Card", peso(m.tenders.cardCentavos));
  add("Opening float", peso(m.cash.openingFloatCentavos));
  add("Float added", peso(m.cash.floatInCentavos));
  add("Paid in", peso(m.cash.paidInCentavos));
  add("Cash drops", peso(m.cash.dropsCentavos));
  add("Cash pickups", peso(m.cash.pickupsCentavos));
  add("Paid out", peso(m.cash.paidOutCentavos));
  add("No-sale drawer opens", m.cash.noSaleCount);
  add("Cash that should be in the drawer", peso(m.cash.expectedCentavos), true);
  if (m.cash.countedCentavos != null) {
    add("Cash counted", peso(m.cash.countedCentavos));
    add("Short / over", peso(m.cash.shortOverCentavos));
  }
  return {
    title: m.kind === "z" ? "Z READING" : "X READING (not a day end)",
    docNumber: m.docNumber,
    reprint: false,
    sample: Boolean(m.sample),
    lines,
    footer: m.sample ? "NOT FILED - SAMPLE" : m.notice,
  };
}

/**
 * Close the business day. Caller has locked the register and authorized the actor. Everything below is one
 * transaction: if any piece fails, no accumulator moves and the day stays open.
 * @param {any} db @param {any} register @param {any} actor @param {{dayId:string, readId:string, at:number}} o
 */
export async function generateZ(db, register, actor, o) {
  const [day] =
    await db`select * from store_till_days where id=${o.dayId} and register_id=${register.id} for update`;
  if (!day) refuse("Choose a till day for this register", "not_found");
  if (day.status === "z_done") refuse("This day already has its Z reading");
  if (day.status === "closed_no_z")
    refuse(
      "This day was closed before Z readings started. It cannot get a Z reading now.",
    );
  const [open] =
    await db`select count(*)::int as n from store_shifts s left join store_shift_closures c on c.shift_id=s.id where s.till_day_id=${day.id} and c.id is null`;
  if (open.n)
    refuse(
      `Close ${open.n === 1 ? "the open cashier session" : `all ${open.n} open cashier sessions`} before the Z reading`,
    );
  const [pending] =
    await db`select count(*)::int as n from store_reversals v join store_shifts h on h.id=v.shift_id where h.till_day_id=${day.id} and v.status='pending'`;
  if (pending.n)
    refuse("Decide pending voids and refunds before the Z reading");
  const [any] =
    await db`select count(*)::int as n from store_shifts where till_day_id=${day.id}`;
  if (!any.n) refuse("This day has no cashier session");
  const { model, next, agg, sessions } = await readingModel(
    db,
    day.id,
    "z",
    true,
  );
  const [last] =
    await db`select s.id from store_shifts s join store_shift_closures c on c.shift_id=s.id where s.till_day_id=${day.id} order by c.closed_at desc,s.id desc limit 1`;
  await db`insert into store_read_sequences(register_id,kind) values(${register.id},'z') on conflict do nothing`;
  const [counter] =
    await db`update store_read_sequences set next_number=next_number+1 where register_id=${register.id} and kind='z' returning next_number-1 as sequence`;
  const sequence = Number(counter.sequence);
  // Z counter and read sequence are the same count; if a legacy gap exists, take the larger and keep both moving.
  const zCounter = Math.max(sequence, next.zCounter);
  if (zCounter !== sequence)
    await db`update store_read_sequences set next_number=${zCounter + 1} where register_id=${register.id} and kind='z'`;
  model.accumulators.zCounter = zCounter;
  const doc = await nextDocNumber(db, register.organization_id, {
    type: "Z",
    locationCode: slipCode(register, null),
    at: o.at,
  });
  model.docNumber = doc;
  model.kind = "z";
  model.provisional = false;
  model.status = "z_done";
  const snapshot = legacySnapshot(model, "z", zCounter);
  await db`insert into store_reads(id,register_id,shift_id,kind,sequence,snapshot,captured_at) values(${o.readId},${register.id},${last.id},'z',${String(zCounter)},${snapshot},${new Date(o.at)})`;
  await db`insert into store_fiscal_accumulators(register_id,z_counter,reset_counter,beginning_gross_centavos,ending_gross_centavos,beginning_net_centavos,ending_net_centavos,till_day_id) values(${register.id},${zCounter},${next.resetCounter},${String(next.beginningGross)},${String(next.endingGross)},${String(next.beginningNet)},${String(next.endingNet)},${day.id})`;
  const s = model.sales,
    t = model.tenders,
    c = model.cash;
  const [z] =
    await db`insert into store_z_readings(till_day_id,register_id,read_id,doc_number,business_date,z_counter,reset_counter,beginning_invoice,ending_invoice,beginning_void,ending_void,beginning_refund,ending_refund,beginning_gross_centavos,ending_gross_centavos,beginning_net_centavos,ending_net_centavos,sessions_count,transactions_count,gross_sales_centavos,promo_discount_centavos,net_sales_centavos,vatable_sales_centavos,vat_centavos,vat_exempt_centavos,zero_rated_centavos,vat_removed_centavos,senior_discount_centavos,pwd_discount_centavos,solo_parent_discount_centavos,athlete_discount_centavos,uniformed_discount_centavos,voids_count,voids_centavos,refunds_count,refunds_centavos,cash_tender_centavos,gcash_tender_centavos,card_tender_centavos,other_tender_centavos,opening_float_centavos,float_in_centavos,paid_in_centavos,drops_centavos,pickups_centavos,paid_out_centavos,no_sale_count,expected_cash_centavos,counted_cash_centavos,short_over_centavos,forced_sessions,model,generated_by)
    values(${day.id},${register.id},${o.readId},${doc},${model.businessDate},${zCounter},${next.resetCounter},${model.invoices.beginning},${model.invoices.ending},${model.voids.beginning},${model.voids.ending},${model.refunds.beginning},${model.refunds.ending},${String(next.beginningGross)},${String(next.endingGross)},${String(next.beginningNet)},${String(next.endingNet)},${sessions.length},${s.transactions},${s.grossCentavos},${s.promoDiscountCentavos},${s.netCentavos},${s.vatableCentavos},${s.vatCentavos},${s.vatExemptCentavos},${s.zeroRatedCentavos},${s.vatRemovedCentavos},${s.privilegeDiscountCentavos.senior},${s.privilegeDiscountCentavos.pwd},${s.privilegeDiscountCentavos.solo_parent},${s.privilegeDiscountCentavos.athlete},${s.privilegeDiscountCentavos.uniformed},${model.voids.count},${model.voids.totalCentavos},${model.refunds.count},${model.refunds.totalCentavos},${t.cashCentavos},${t.gcashCentavos},${t.cardCentavos},${t.otherCentavos},${c.openingFloatCentavos},${c.floatInCentavos},${c.paidInCentavos},${c.dropsCentavos},${c.pickupsCentavos},${c.paidOutCentavos},${c.noSaleCount},${c.expectedCentavos},${c.countedCentavos},${c.shortOverCentavos},${c.forcedSessions},${{ ...model, journal: undefined }},${actor.profileId})
    returning id`;
  await db`update store_till_days set status='z_done',z_done_at=${new Date(o.at)},z_by=${actor.profileId},updated_at=now() where id=${day.id}`;
  void agg;
  return { id: z.id, readId: o.readId, docNumber: doc, zCounter, model };
}

/** The old store_reads.snapshot shape, kept so old rows, deposits and the X journal stay readable.
 * @param {any} model @param {"x"|"z"} kind @param {number} sequence */
export function legacySnapshot(model, kind, sequence) {
  return {
    kind,
    sequence: String(sequence),
    store: model.store,
    register: model.register,
    date: model.businessDate,
    salesCentavos: model.sales.netAfterReturnsCentavos,
    basketCount: model.sales.transactions,
    tenders: model.tenders.list,
    vat: {
      vatableSalesMinor: model.sales.vatableCentavos,
      vatMinor: model.sales.vatCentavos,
      vatExemptMinor: model.sales.vatExemptCentavos,
      zeroRatedMinor: model.sales.zeroRatedCentavos,
    },
    journal: model.journal,
    sample: model.sample,
    notice: model.notice,
    typed: kind === "z",
  };
}

/** A typed Z row as the read API returns it; money as strings. @param {any} z */
export function zView(z) {
  const m = (/** @type {any} */ v) => (v == null ? null : String(v));
  return {
    id: z.id,
    tillDayId: z.till_day_id,
    registerId: z.register_id,
    readId: z.read_id,
    docNumber: z.doc_number,
    businessDate: dayString(z.business_date),
    zCounter: Number(z.z_counter),
    resetCounter: z.reset_counter,
    beginningInvoice: z.beginning_invoice,
    endingInvoice: z.ending_invoice,
    beginningVoid: z.beginning_void,
    endingVoid: z.ending_void,
    beginningGrossCentavos: m(z.beginning_gross_centavos),
    endingGrossCentavos: m(z.ending_gross_centavos),
    beginningNetCentavos: m(z.beginning_net_centavos),
    endingNetCentavos: m(z.ending_net_centavos),
    grossSalesCentavos: m(z.gross_sales_centavos),
    netSalesCentavos: m(z.net_sales_centavos),
    vatableSalesCentavos: m(z.vatable_sales_centavos),
    vatCentavos: m(z.vat_centavos),
    vatExemptCentavos: m(z.vat_exempt_centavos),
    zeroRatedCentavos: m(z.zero_rated_centavos),
    vatRemovedCentavos: m(z.vat_removed_centavos),
    seniorDiscountCentavos: m(z.senior_discount_centavos),
    pwdDiscountCentavos: m(z.pwd_discount_centavos),
    soloParentDiscountCentavos: m(z.solo_parent_discount_centavos),
    athleteDiscountCentavos: m(z.athlete_discount_centavos),
    uniformedDiscountCentavos: m(z.uniformed_discount_centavos),
    voidsCount: z.voids_count,
    voidsCentavos: m(z.voids_centavos),
    refundsCount: z.refunds_count,
    refundsCentavos: m(z.refunds_centavos),
    cashTenderCentavos: m(z.cash_tender_centavos),
    gcashTenderCentavos: m(z.gcash_tender_centavos),
    cardTenderCentavos: m(z.card_tender_centavos),
    otherTenderCentavos: m(z.other_tender_centavos),
    openingFloatCentavos: m(z.opening_float_centavos),
    dropsCentavos: m(z.drops_centavos),
    pickupsCentavos: m(z.pickups_centavos),
    paidOutCentavos: m(z.paid_out_centavos),
    paidInCentavos: m(z.paid_in_centavos),
    expectedCashCentavos: m(z.expected_cash_centavos),
    countedCashCentavos: m(z.counted_cash_centavos),
    shortOverCentavos: m(z.short_over_centavos),
    sessionsCount: z.sessions_count,
    transactionsCount: z.transactions_count,
    generatedAt: +new Date(z.generated_at),
    typed: true,
  };
}
