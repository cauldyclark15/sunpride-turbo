#!/usr/bin/env bun
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createDb, tx } from "../src/client.js";
import { rowId, todayManila, plusDays } from "./store.js";

export const DISTRIBUTOR_SAMPLE_BATCH = "sunpride-distributor-spec-v1";
/** Explicit sample defaults, editable/versioned through the portal admin, never client policy. */
export const SAMPLE_DISTRIBUTOR_POLICY = {
  doiWindowDays: 28,
  stockFreshDays: 1,
  nearExpiryDays: 30,
  understockDays: 7,
  overstockDays: 45,
  creditMaxAgeSeconds: 86400,
  reconciliationToleranceBase: 24,
  requiredDocuments: ["registration", "tax", "credit"],
  claimTypes: [
    { kind: "damage", minimumEvidence: 1 },
    { kind: "promotion", minimumEvidence: 1 },
    { kind: "freight", minimumEvidence: 1 },
    { kind: "shortage", minimumEvidence: 1 },
  ],
  scorecardWeights: {
    submission: 15,
    coverage: 15,
    growth: 15,
    stock: 15,
    payment: 15,
    infrastructure: 15,
    manpower: 10,
  },
  secondaryTargetCentavos: 25000000,
};
/** Stable sample document with a real PDF xref and text layer; no fabricated client agreements.
 * @param {string} title */
export function samplePdf(title) {
  const content = `BT /F1 16 Tf 50 750 Td (${title.replace(/[()\\]/g, "")}) Tj 0 -30 Td (FICTIONAL SAMPLE - not a legal agreement or client document.) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let out = "%PDF-1.4\n",
    offsets = [0];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => String(n).padStart(10, "0") + " 00000 n \n")
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out);
}
/** Additive, idempotent partner sample extension. Does NOT reset any database.
 * Passwords are persisted once in an atomically replaced 0600 record keyed by database.
 * @param {import('../src/client.js').Db} db @param {{credentialsPath?:string,anchorDate?:string}} [options] */
export async function seedDistributors(db, options = {}) {
  const day = options.anchorDate ?? todayManila();
  const recordPath =
    options.credentialsPath ??
    join(homedir(), ".sunpride-keys/distributor-portal-logins.json");
  await mkdir(dirname(recordPath), { recursive: true, mode: 0o700 });
  /** @type {Record<string,any>} */ let record = {};
  try {
    record = JSON.parse(await readFile(recordPath, "utf8"));
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code !== "ENOENT") throw e;
  }
  const [{ name: database }] = await db`select current_database() as name`;
  const accounts = record[database] ?? {};
  for (const slug of ["harbour", "highland"])
    if (!accounts[slug])
      accounts[slug] = {
        email: `${slug}@partner.sunpride.test`,
        password: crypto.randomUUID() + "aB7!",
        name:
          slug === "harbour"
            ? "Sample Harbour Distribution"
            : "Sample Highland Distribution",
      };
  record[database] = accounts;
  const temp = `${recordPath}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(record, null, 2) + "\n", {
    mode: 0o600,
  });
  await chmod(temp, 0o600);
  await rename(temp, recordPath);
  await chmod(recordPath, 0o600);
  const hashes = await Promise.all(
    Object.values(accounts).map((a) =>
      Bun.password.hash(a.password, { algorithm: "argon2id" }),
    ),
  );
  return tx(db, async (t) => {
    await t`select pg_advisory_xact_lock(4310500)`;
    const [root] =
      await t`select id from org_units where code='SUNPRIDE' and deleted_at is null`;
    const products =
      await t`select p.* from products p join sample_data_rows m on m.table_name='products' and m.row_id=p.id::text where p.active and p.deleted_at is null order by p.code limit 3`;
    const stores =
      await t`select o.*,a.territory_id from outlets o join sample_data_rows m on m.table_name='outlets' and m.row_id=o.id::text left join outlet_assignments a on a.outlet_id=o.id and a.effective_from<=now() and (a.effective_to is null or a.effective_to>now()) and a.deleted_at is null where o.deleted_at is null order by o.code limit 8`;
    if (!root || products.length < 2 || !stores.length)
      throw new Error("Demo company must be seeded before distributor samples");
    let added = 0;
    /** Only internal identifiers from this function, values are parameterized.
     * @param {string} table @param {string} key @param {Record<string,any>} data */
    async function add(table, key, data) {
      const id = rowId(table, `distributor:${key}`),
        marker = rowId("sample_data_rows", `distributor:${table}:${key}`);
      const [owned] =
        await t`select row_id from sample_data_rows where id=${marker}`;
      const [existing] = await t.unsafe(
        `select id from "${table}" where id=$1`,
        [id],
      );
      if (existing && !owned)
        throw new Error("Sample ownership conflict; no rows changed");
      if (!existing) {
        const columns = Object.keys(data),
          values = Object.values(data);
        const jsonColumns = new Set([
          "rule",
          "settings",
          "payload",
          "pricing_snapshot",
          "sap_acknowledgement",
          "credit_assessment",
        ]);
        // Force serialized JSON through TEXT; Bun otherwise encodes it as a JSON string.
        const placeholders = columns.map(
          (column, i) =>
            `$${i + 2}${jsonColumns.has(column) ? "::text::jsonb" : ""}`,
        );
        await t.unsafe(
          `insert into "${table}" (id,${columns.map((k) => `"${k}"`).join(",")}) values($1,${placeholders.join(",")})`,
          [id, ...values],
        );
        await t`insert into sample_data_rows(id,batch,table_name,row_id,key) values(${marker},${DISTRIBUTOR_SAMPLE_BATCH},${table},${id},${`distributor:${table}:${key}`})`;
        added++;
      }
      return id;
    }
    for (const [index, slug] of ["harbour", "highland"].entries()) {
      const account = accounts[slug],
        id = rowId("distributors", `distributor:${slug}`),
        userId = rowId("users", `distributor:${slug}`),
        profileId = rowId("profiles", `distributor:${slug}`);
      const credit = {
        checkedAt: new Date().toISOString(),
        limitCentavos: 50000000,
        exposureCentavos: index ? 32000000 : 12000000,
        ageing: {
          current: 10000000,
          d1_30: index ? 18000000 : 2000000,
          d31_60: index ? 4000000 : 0,
        },
      };
      const priceListId = await add("price_lists", slug, {
        organization_id: "sunpride",
        code: `SAMPLE-DISTRIBUTOR-${slug}`,
        name: `${account.name} sample prices`,
        channel_key: "distributor",
        currency: "PHP",
        status: "active",
        source: "sample",
        effective_from: "2020-01-01",
      });
      const catalog = products.map(
        (/** @type {any} */ p, /** @type {number} */ i) => ({
          productId: p.id,
          priceListId,
          uom: "CS",
          unitsPerUom: 24,
          priceCentavos: 24000 + i * 6000,
          availableBase: 24000,
        }),
      );
      for (const p of catalog)
        await add("price_list_lines", `${slug}-${p.productId}`, {
          organization_id: "sunpride",
          price_list_id: priceListId,
          product_id: p.productId,
          uom: p.uom,
          unit_price_minor: p.priceCentavos,
          effective_from: "2020-01-01",
        });
      const promotionId = await add("promotions", slug, {
        organization_id: "sunpride",
        code: `SAMPLE-PARTNER-${slug}`,
        name: "Sample partner five-percent benefit",
        rule_kind: "percent_off",
        price_list_id: priceListId,
        rule: JSON.stringify({
          kind: "percent_off",
          item: { productId: catalog[0].productId, uom: "CS", quantity: 1 },
          percentOffBasisPoints: 500,
        }),
        status: "active",
        source: "sample",
        effective_from: "2020-01-01",
      });
      // Repair only our own invalid historical sample encodings; never office or partner rows.
      await t`update promotions set rule=(rule#>>'{}')::jsonb,price_list_id=${priceListId} where id=${promotionId} and source='sample' and jsonb_typeof(rule)='string'`;
      const payload = {
        sampleVersion: 3,
        products: catalog,
        outlets: stores.map((/** @type {any} */ s) => ({
          outletId: s.id,
          territoryId: s.territory_id,
        })),
        terms: {
          paymentTerms: "SAMPLE: net 30 days",
          deliveryLeadDays: index ? 3 : 2,
        },
        credit,
        mockSapCustomerCode: `MOCK-${slug.toUpperCase()}`,
        schemes: [
          { promotionId, distributorIds: [id], channelKeys: ["distributor"] },
        ],
      };
      await add("distributors", slug, {
        code: `SAMPLE-${slug.toUpperCase()}`,
        name: account.name,
        org_unit_id: root.id,
        status: "accredited",
        sap_customer_code: payload.mockSapCustomerCode,
        source: "sample",
        effective_from: "2020-01-01",
      });
      const [partnerType] =
        await t`select id from org_unit_types where organization_id='sunpride' and code='PARTNER'`;
      if (!partnerType)
        await add("org_unit_types", "partner-type", {
          organization_id: "sunpride",
          code: "PARTNER",
          label: "Partner device scope",
          level: 5,
          active: true,
        });
      const deviceScope = await add("org_units", `${slug}-device-scope`, {
        organization_id: "sunpride",
        code: `PARTNER-SAMPLE-${slug}`,
        name: account.name,
        type_code: "PARTNER",
        parent_id: root.id,
        status: "active",
        effective_from: "2020-01-01",
      });
      await t`update distributors set device_org_unit_id=${deviceScope} where id=${id} and device_org_unit_id is null`;
      await add("users", slug, {
        email: account.email,
        password_hash: hashes[index],
      });
      await add("profiles", slug, {
        user_id: userId,
        auth_subject: userId,
        email: account.email,
        name: account.name,
        role: "distributor",
        status: "active",
        employment_type: "third_party",
        org_unit_id: deviceScope,
      });
      await t`update profiles set org_unit_id=${deviceScope},scope_epoch=scope_epoch+1 where id=${profileId} and (org_unit_id is null or org_unit_id=${root.id}) and exists(select 1 from sample_data_rows where table_name='profiles' and row_id=${profileId}::text and batch=${DISTRIBUTOR_SAMPLE_BATCH})`;
      await add("distributor_users", slug, {
        distributor_id: id,
        profile_id: profileId,
        grants:
          "{read,order,stock,secondary,claim,finance,documents,dsr,settlement}",
        effective_from: "2020-01-01",
      });
      await add("distributor_policies", slug, {
        distributor_id: id,
        version: 1,
        settings: JSON.stringify(SAMPLE_DISTRIBUTOR_POLICY),
        effective_from: "2020-01-01",
      });
      await t`update distributor_policies p set settings=(settings#>>'{}')::jsonb where p.distributor_id=${id} and jsonb_typeof(settings)='string' and exists(select 1 from sample_data_rows m where m.table_name='distributor_policies' and m.row_id=p.id::text and m.batch=${DISTRIBUTOR_SAMPLE_BATCH})`;
      const [current] =
        await t`select * from distributor_master_versions where distributor_id=${id} order by version desc limit 1`;
      const version = current ? Number(current.version) + 1 : 1,
        stamp = new Date();
      // Refresh only our untouched sample replica on a new Manila day; never replace office edits.
      let masterId = current?.id;
      if (
        !current ||
        (current.source_key === `sample:${slug}` &&
          (current.effective_to ||
            current.payload.sampleVersion !== 3 ||
            new Date(new Date(current.received_at).getTime() + 28800000)
              .toISOString()
              .slice(0, 10) !== day))
      ) {
        if (current) {
          await t`update distributor_master_versions set effective_to=${stamp} where id=${current.id} and effective_to is null`;
          await t`update distributor_outlets set effective_to=${stamp} where distributor_id=${id} and effective_to is null`;
        }
        masterId = await add(
          "distributor_master_versions",
          `${slug}-${day}-v3`,
          {
            distributor_id: id,
            source: "sample",
            source_key: `sample:${slug}`,
            version,
            payload_hash: new Bun.CryptoHasher("sha256")
              .update(JSON.stringify(payload))
              .digest("hex"),
            payload: JSON.stringify(payload),
            effective_from: current ? stamp : new Date("2020-01-01"),
            received_at: stamp,
          },
        );
        for (const s of stores)
          await add("distributor_outlets", `${slug}-${s.id}-${day}-v3`, {
            distributor_id: id,
            outlet_id: s.id,
            territory_id: s.territory_id,
            master_version_id: masterId,
            effective_from: current ? stamp : new Date("2020-01-01"),
          });
      }
      const warehouse = await add("distributor_locations", `${slug}-WH`, {
        distributor_id: id,
        code: "WH",
        name: "Sample partner warehouse",
        kind: "warehouse",
        effective_from: "2020-01-01",
      });
      const van = await add("distributor_locations", `${slug}-VAN`, {
        distributor_id: id,
        code: "VAN",
        name: "Sample partner van",
        kind: "van",
        effective_from: "2020-01-01",
      });
      for (const [kind, rows] of [
        ["product", products],
        ["outlet", stores],
        [
          "location",
          [
            { id: warehouse, code: "WH" },
            { id: van, code: "VAN" },
          ],
        ],
      ])
        for (const row of /** @type {any[]} */ (rows))
          await add("distributor_code_maps", `${slug}-${kind}-${row.code}`, {
            distributor_id: id,
            kind,
            external_code: row.code,
            entity_id: row.id,
            effective_from: "2020-01-01",
          });
      // 56 days establish real prior-period comparison; every day balances at invoice-line grain.
      for (let n = -56; n <= 0; n++) {
        const date = plusDays(day, n);
        const decl = await add(
          "distributor_stock_declarations",
          `${slug}-${date}`,
          {
            distributor_id: id,
            stock_date: date,
            revision: 1,
            request_key: `sample:${slug}:${date}`,
            payload_hash: `sample-${slug}-${date}`,
            source: "sample",
            submitted_by: profileId,
          },
        );
        for (const [i, p] of catalog.entries()) {
          const qty = (index ? 3 : 5) + (((n % 3) + 3) % 3);
          const remaining = (index ? 2400 : 720) + i * 240;
          for (const [loc, locQty] of [
            [warehouse, remaining],
            [van, 240],
          ])
            await add(
              "distributor_stock_lines",
              `${slug}-${date}-${p.productId}-${loc}`,
              {
                declaration_id: decl,
                product_id: p.productId,
                location_id: loc,
                batch: `SAMPLE-${i + 1}`,
                expiry: plusDays(day, i === 0 ? 10 : 180),
                uom: "CS",
                quantity_base: locQty,
              },
            );
          if (n === -56) continue;
          await add(
            "distributor_primary_movements",
            `${slug}-${date}-${p.productId}`,
            {
              distributor_id: id,
              source_key: `sample:${slug}:${date}:${i}`,
              version: 1,
              movement_date: date,
              product_id: p.productId,
              quantity_base: qty * 24 + (index && n === 0 ? 48 : 0),
              kind: "shipment",
              source: "sample",
              received_at: new Date(`${date}T03:00:00Z`),
            },
          );
          await add(
            "distributor_secondary_lines",
            `${slug}-${date}-${p.productId}`,
            {
              distributor_id: id,
              invoice_number: `SAMPLE-${slug}-${date}`,
              line_key: String(i + 1),
              revision: 1,
              source_key: `sample:${slug}:${date}`,
              payload_hash: `sample-${slug}-${date}-${i}`,
              sale_date: date,
              kind: "sale",
              outlet_id: stores[(n + 56 + i) % stores.length].id,
              product_id: p.productId,
              location_id: warehouse,
              batch: `SAMPLE-${i + 1}`,
              uom: "CS",
              quantity_base: qty * 24,
              amount_centavos: qty * p.priceCentavos,
              quantity_units: qty,
              units_per_uom: 24,
            },
          );
        }
        if (n > -56)
          await add("distributor_ingest_runs", `${slug}-${date}`, {
            distributor_id: id,
            source_key: `sample:${slug}:${date}`,
            payload_hash: `sample-${slug}-${date}`,
            adapter: "canonical",
            submitted_by: profileId,
            complete: true,
            period_from: date,
            period_to: date,
          });
        if (n > -56) {
          const runId = rowId(
            "distributor_ingest_runs",
            `distributor:${slug}-${date}`,
          );
          await t`update distributor_ingest_runs set complete=true,period_from=${date},period_to=${date} where id=${runId} and not complete and exists(select 1 from sample_data_rows m where m.row_id=${runId}::text and m.table_name='distributor_ingest_runs' and m.batch=${DISTRIBUTOR_SAMPLE_BATCH})`;
          await add("distributor_primary_feed_receipts", `${slug}-${date}`, {
            distributor_id: id,
            source_key: `sample:${slug}:${date}`,
            version: 1,
            payload_hash: `sample-${slug}-${date}`,
            period_from: date,
            period_to: date,
            source: "sample",
          });
        }
      }
      const primaryOrder = await add("orders", `${slug}-${day}`, {
        organization_id: "sunpride",
        client_request_id: `sample-distributor:${slug}:${day}`,
        order_number: `SAMPLE-DP-${slug}-${day}`,
        order_type: "distributor_primary",
        customer_code: payload.mockSapCustomerCode,
        salesperson_subject: userId,
        created_by_subject: userId,
        purchasing_distributor_id: id,
        customer_po_number: `SAMPLE-PO-${day}`,
        channel_key: "distributor",
        service_date: day,
        status: "submitted",
        subtotal: 480,
        total: 456,
        subtotal_centavos: 48000,
        total_centavos: 45600,
        amount_known: true,
        pricing_snapshot: JSON.stringify({
          source: "sample",
          label: "FICTIONAL SAMPLE five-percent partner order",
        }),
        acknowledged_at: new Date(),
        promised_delivery_date: plusDays(day, index ? 3 : 2),
        sap_acknowledgement: JSON.stringify({
          source: "sample",
          authority: "Mock SAP",
          reference: `SAMPLE-ACK-${slug}-${day}`,
        }),
      });
      await add("order_lines", `${slug}-${day}`, {
        order_id: primaryOrder,
        ordinal: 0,
        product_id: catalog[0].productId,
        product_code: products[0].code,
        description: products[0].name,
        uom: "CS",
        quantity: 2,
        quantity_base: 48,
        unit_price: 240,
        line_total: 456,
        unit_price_centavos: 24000,
        line_total_centavos: 45600,
      });
      for (const [i, amount] of [4500000, index ? 6500000 : 750000].entries())
        await add("distributor_ar_items", `${slug}-${i}`, {
          distributor_id: id,
          source_key: `SAMPLE-AR-${i + 1}`,
          version: 1,
          invoice_number: `SAMPLE-PRIMARY-${i + 1}`,
          due_date: plusDays(day, i ? -35 : 15),
          balance_centavos: amount,
          source: "sample",
          received_at: new Date(),
          effective_from: "2020-01-01",
        });
      for (const kind of ["circular", "agreement", "claim", "deposit"]) {
        const bytes = samplePdf(`Sample ${slug} ${kind}`),
          docId = await add("distributor_documents", `${slug}-${kind}`, {
            distributor_id: id,
            kind,
            title: `Sample ${kind === "circular" ? "weekly circular" : kind}`,
            version: 1,
            content: bytes,
            mime: "application/pdf",
            sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
            uploaded_by: profileId,
            published: ["circular", "agreement"].includes(kind),
          });
        if (kind === "claim") {
          const claimId = await add("distributor_claims", slug, {
            distributor_id: id,
            claim_number: `SAMPLE-CLAIM-${slug}`,
            kind: "damage",
            period_from: plusDays(day, -7),
            period_to: day,
            amount_centavos: 180000,
            reason:
              "Sample damaged outer cartons; evidence pending intake review",
            status: "submitted",
            submitted_by: profileId,
          });
          await add("distributor_claim_evidence", slug, {
            claim_id: claimId,
            document_id: docId,
          });
        }
        if (kind === "deposit")
          await add("distributor_remittances", slug, {
            distributor_id: id,
            deposit_reference: `SAMPLE-DEPOSIT-${slug}`,
            deposit_date: day,
            amount_centavos: 300000,
            evidence_id: docId,
            submitted_by: profileId,
          });
      }
      await add("distributor_capability_audits", `${slug}-${day}`, {
        distributor_id: id,
        audit_date: day,
        infrastructure_score: index ? 65 : 90,
        manpower_score: index ? 70 : 85,
        findings:
          "FICTIONAL SAMPLE: warehouse readiness and trained field staff",
        audited_by: profileId,
      });
    }
    return { distributors: 2, added, credentialsPath: recordPath };
  });
}
if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL required");
  const db = createDb(url, { max: 1 });
  try {
    console.log(JSON.stringify(await seedDistributors(db)));
  } catch {
    console.error(
      "Distributor sample extension failed; no password or SQL values printed.",
    );
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}
