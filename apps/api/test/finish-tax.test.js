import { test, expect } from "bun:test";
import { tx } from "@sunpride/db/client";
import { writeFile } from "node:fs/promises";
import {
  startHarness,
  profileStore,
  boundDevice,
  createUser,
} from "./harness.js";
import { actorFor } from "../src/core/context.js";
import {
  saveRegistration,
  createSeries,
  allocateDocumentNumber,
  issueDocument,
} from "../src/domains/fiscal/series.js";
import { invoiceForSale } from "../src/domains/fiscal/transactions.js";
import {
  invoiceTaxSnapshot,
  collectionTaxReference,
} from "../src/domains/fiscal/taxes.js";
import { quoteSapCondition } from "../src/domains/integration/replicas.js";
import { sampleMaster } from "../../sap-mock/src/sample.js";
import { validate } from "../../../packages/integration-contracts/sap/v1/index.js";

test("F-109 mixed governed tax is frozen; exclusive unit quote is preserved and a collection never recognizes tax again", async () => {
  const h = await startHarness();
  try {
    const at = Date.now(),
      listId = crypto.randomUUID();
    const specs = [
      { kind: "vatable", bps: 1200, inclusive: true, unit: 11200, qty: 1 },
      { kind: "exempt", bps: 0, inclusive: true, unit: 3000, qty: 1 },
      { kind: "zero_rated", bps: 0, inclusive: true, unit: 5000, qty: 1 },
      { kind: "vatable", bps: 1200, inclusive: false, unit: 1, qty: 100 },
    ];
    /** @type {any[]} */ const lines = [],
      taxQuotes = [];
    for (const [i, s] of specs.entries()) {
      const m = sampleMaster("condition", `SAMPLE-TAX-${i}`, {
        productCode: `SAMPLE-${i}`,
        uom: "EA",
        customerCode: null,
        channelKey: null,
        priceListCode: "SAMPLE-PRICE",
        unitPriceCentavos: s.unit,
        currency: "PHP",
        taxCode: `SAMPLE-${s.kind}`,
        taxBasisPoints: s.bps,
        taxTreatment: s.kind,
        taxInclusive: s.inclusive,
        precedence: 1,
        ...(!s.inclusive
          ? { sellingUnitPriceCentavos: 1, unitTaxCentavos: 0 }
          : {}),
      });
      m.effectiveFrom = at - 60000;
      validate("condition", m);
      const q = quoteSapCondition({
        payload: m,
        source: "sample",
        price_list_id: listId,
        sap_key: m.key,
        sap_version: m.version,
        effective_from: new Date(m.effectiveFrom),
        effective_to: null,
      });
      const source = {
        taxCode: q.taxCode,
        taxBasisPoints: q.taxBasisPoints,
        taxTreatment: q.taxTreatment,
        sourceTaxInclusive: q.sourceTaxInclusive,
        sourceNetUnitMinor: String(q.sourceUnitPriceCentavos),
        sourceSellingUnitMinor: String(q.unitPriceCentavos),
        sapConditionKey: q.sapKey,
        sapConditionVersion: q.sapVersion,
      };
      const productId = crypto.randomUUID(),
        gross = BigInt(q.unitPriceCentavos ?? 0) * BigInt(s.qty);
      lines.push({
        productId,
        code: m.data.productCode,
        name: `SAMPLE ${s.kind}`,
        uomCode: "EA",
        quantityScale: "1",
        quantityBase: String(s.qty),
        unitPriceMinor: String(q.unitPriceCentavos),
        grossMinor: String(gross),
        discountMinor: "0",
        totalMinor: String(gross),
        priceListId: listId,
        ...source,
      });
      taxQuotes.push({
        priceListId: listId,
        productId,
        uomCode: "EA",
        treatment: q.taxTreatment,
        taxCode: q.taxCode,
        taxBasisPoints: q.taxBasisPoints,
        sourceTaxInclusive: q.sourceTaxInclusive,
        sourceNetUnitMinor: source.sourceNetUnitMinor,
        sourceSellingUnitMinor: source.sourceSellingUnitMinor,
        sourceKey: q.sapKey,
        sourceVersion: q.sapVersion,
        effectiveFrom: m.effectiveFrom,
        effectiveTo: null,
      });
    }
    const total = lines
      .reduce((n, l) => n + BigInt(l.totalMinor), 0n)
      .toString();
    const tax = invoiceTaxSnapshot(lines, total);
    expect(tax).toMatchObject({
      vatableSalesMinor: "10100",
      vatMinor: "1200",
      vatExemptMinor: "3000",
      zeroRatedMinor: "5000",
      totalMinor: "19300",
    });
    expect(collectionTaxReference(tax)).toEqual({
      tax: null,
      taxRecognition: "payment_application_only",
      invoiceTax: tax,
    });
    expect(() =>
      invoiceTaxSnapshot(
        [{ ...lines[1], taxTreatment: null }],
        lines[1].totalMinor,
      ),
    ).toThrow("governed tax treatment");
    const people = profileStore(h),
      unit = crypto.randomUUID();
    h.setHooks({ unitInScope: async () => true });
    await h.db`insert into org_units(id,organization_id,code,name,type_code,status,effective_from) values(${unit},'sunpride','SUNPRIDE','SAMPLE','national','active',now()-interval '1 day')`;
    await h.db`insert into sample_data_rows(batch,table_name,row_id,key) values('finish-tax','org_units',${unit},'SAMPLE')`;
    const seller = await boundDevice(h, people, {
      orgUnitId: unit,
      app: "van-android",
    });
    const bossId = await createUser(
      h,
      "tax-admin@example.test",
      "test-only-tax-password",
    );
    const boss = {
      userId: bossId,
      email: "tax-admin@example.test",
      profile: people.set(bossId, {
        role: "super_admin",
        orgUnitId: unit,
        name: "SAMPLE admin",
      }),
    };
    for (const user of [seller, boss]) {
      const p = user.profile;
      await h.db`insert into profiles(id,user_id,auth_subject,name,email,role,status,org_unit_id) values(${p.id},${user.userId},${user.userId},${p.name},${user.email},${p.role},'active',${unit})`;
      await h.db`insert into employee_assignments(profile_id,org_unit_id,role,effective_from,actor_subject,reason) values(${p.id},${unit},${p.role},now()-interval '1 day','SAMPLE','SAMPLE')`;
    }
    const actor = await actorFor(h.db, seller.userId),
      admin = await actorFor(h.db, bossId);
    if (!actor || !admin) throw new Error("SAMPLE actors missing");
    const reg = await tx(h.db, (db) =>
      saveRegistration(db, admin, {
        orgUnitId: unit,
        entityName: "SAMPLE",
        branchName: "SAMPLE",
        tin: "SAMPLE",
        address: "SAMPLE",
        documentType: "sales_invoice",
        status: "sample_not_filed",
        effectiveFrom: "2026-01-01T00:00:00Z",
      }),
    );
    const series = await tx(h.db, (db) =>
      createSeries(db, admin, {
        registrationId: reg.id,
        prefix: "SAMPLE-0575-TAX",
        firstSerial: "570",
        lastSerial: "571",
        effectiveFrom: "2026-01-01T00:00:00Z",
      }),
    );
    const range = await tx(h.db, (db) =>
      allocateDocumentNumber(db, {
        actor,
        deviceId: seller.deviceId,
        seriesId: series.id,
        requestKey: crypto.randomUUID(),
        count: 2,
      }),
    );
    const capturedAt = Date.now();
    const p = {
      saleId: crypto.randomUUID(),
      deviceTime: capturedAt,
      fiscal: { allocationId: range.allocationId, serial: "570", tax },
    };
    const receipt = { totalMinor: total, lines };
    const trip = { org_unit_id: unit, vehicle_id: null };
    await expect(
      tx(h.db, (db) =>
        invoiceForSale(
          db,
          actor,
          trip,
          { ...p, fiscal: { ...p.fiscal, tax: { ...tax, vatMinor: "0" } } },
          receipt,
          seller.deviceId,
        ),
      ),
    ).rejects.toThrow("Selling tax changed");
    expect(
      String(
        (
          await h.db`select next_issue from fiscal_allocations where id=${range.allocationId}`
        )[0].next_issue,
      ),
    ).toBe("570");
    const document = await tx(h.db, (db) =>
      invoiceForSale(db, actor, trip, p, receipt, seller.deviceId),
    );
    expect(
      (
        await h.db`select snapshot from fiscal_documents where id=${document.id}`
      )[0].snapshot.tax,
    ).toEqual(tax);
    const orReg = await tx(h.db, (db) =>
      saveRegistration(db, admin, {
        orgUnitId: unit,
        entityName: "SAMPLE",
        branchName: "SAMPLE",
        tin: "SAMPLE",
        address: "SAMPLE",
        documentType: "official_receipt",
        status: "sample_not_filed",
        effectiveFrom: "2026-01-01T00:00:00Z",
      }),
    );
    const orSeries = await tx(h.db, (db) =>
      createSeries(db, admin, {
        registrationId: orReg.id,
        prefix: "SAMPLE-0575-OR",
        firstSerial: "572",
        lastSerial: "573",
        effectiveFrom: "2026-01-01T00:00:00Z",
      }),
    );
    const orRange = await tx(h.db, (db) =>
      allocateDocumentNumber(db, {
        actor,
        deviceId: seller.deviceId,
        seriesId: orSeries.id,
        requestKey: crypto.randomUUID(),
        count: 1,
      }),
    );
    const collection = await tx(h.db, (db) =>
      issueDocument(db, {
        actor,
        deviceId: seller.deviceId,
        allocationId: orRange.allocationId,
        documentType: "official_receipt",
        sourceType: "van_collection",
        sourceId: crypto.randomUUID(),
        serial: "572",
        at: Date.now(),
        snapshot: {
          totalMinor: String(BigInt(total) / 2n),
          invoiceNumber: document.document_number,
          ...collectionTaxReference(tax),
        },
      }),
    );
    const [savedOr] =
      await h.db`select snapshot from fiscal_documents where id=${collection.id}`;
    expect(savedOr.snapshot.tax).toBeNull();
    expect(savedOr.snapshot.invoiceTax).toEqual(tax);
    const frozen = (/** @type {any} */ d) => ({
      number: d.document_number,
      allocationId: d.allocation_id,
      serial: String(d.serial),
      snapshot: d.snapshot,
    });
    if (process.env.SP_NATIVE_TAX_WIRE)
      await writeFile(
        process.env.SP_NATIVE_TAX_WIRE,
        JSON.stringify({
          at: capturedAt,
          priceListId: listId,
          lines,
          policy: { taxVersion: 1, taxQuotes },
          expected: tax,
          invoice: frozen(document),
          collection: frozen(collection),
        }),
        { mode: 0o600 },
      );
  } finally {
    await h.close();
  }
}, 120000);
