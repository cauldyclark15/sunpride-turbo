import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { quoteSapCondition } from "../src/domains/integration/replicas.js";
import { startMock } from "../../sap-mock/src/server.js";
import { sampleMaster, sampleMasters } from "../../sap-mock/src/sample.js";
import { validate } from "../../../packages/integration-contracts/sap/v1/index.js";

test("F-016 mock SAP supplies a full exclusive-tax quote, accepted with its net/tax provenance", async () => {
  const dir = await mkdtemp(
    join(process.env.TMPDIR ?? "/tmp", "finish-a-quote-"),
  );
  const mock = startMock({
    path: join(dir, "mock.sqlite"),
    port: 0,
    seed: false,
  });
  try {
    const fixture = sampleMasters.find((m) => m.kind === "condition");
    const input = sampleMaster("condition", "SAMPLE-EXCLUSIVE", {
      ...fixture.data,
      unitPriceCentavos: 10001,
      taxInclusive: false,
    });
    mock.putMaster(input);
    const record = JSON.parse(
      mock.db.query("select body from masters where key=?").get(input.key).body,
    );
    validate("condition", record);
    expect(record.data.sellingUnitPriceCentavos).toBe(11201);
    expect(record.data.unitTaxCentavos).toBe(1200);
    const quote = quoteSapCondition({
      payload: record,
      source: record.source,
      sap_key: record.key,
      sap_version: record.version,
      effective_from: new Date(record.effectiveFrom),
      effective_to: null,
    });
    expect(quote.unitPriceCentavos).toBe(11201);
    expect(quote.taxInclusive).toBe(true);
    expect(quote.sourceTaxInclusive).toBe(false);
    expect(quote.sourceUnitPriceCentavos).toBe(10001);
    expect(quote.source).toBe("sap_sample");
  } finally {
    mock.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
test("F-016 absent, inconsistent or unsafe exclusive-tax quotes remain unavailable for selling and credit", () => {
  for (const extra of [
    {},
    { sellingUnitPriceCentavos: 10000, unitTaxCentavos: 0 },
    { sellingUnitPriceCentavos: 11200, unitTaxCentavos: 1199 },
    {
      sellingUnitPriceCentavos: Number.MAX_SAFE_INTEGER + 1,
      unitTaxCentavos: 1200,
    },
  ]) {
    const quote = quoteSapCondition({
      payload: {
        data: {
          unitPriceCentavos: 10000,
          taxBasisPoints: 1200,
          taxInclusive: false,
          ...extra,
        },
      },
    });
    expect(quote.unitPriceCentavos).toBeNull();
    expect(quote.source).toBe("sap_tax_quote_required");
  }
});
