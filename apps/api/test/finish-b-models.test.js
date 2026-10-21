import { test, expect } from "bun:test";
import {
  trainOrderModel,
  predictOrder,
  modelSuggestion,
} from "../src/domains/analytics/order-model.js";
import {
  inferShelf,
  shelfFacts,
} from "../src/domains/analytics/shelf-model.js";

const rows = Array.from({ length: 12 }, (_, i) => ({
  observed_at: new Date(Date.UTC(2026, 0, i + 1)),
  split: i < 10 ? "train" : "temporal_holdout",
  annotations: {
    historyDailyBase: i + 1,
    offtakeDailyBase: (i + 1) * 2,
    seasonSin: 0,
    seasonCos: 1,
    promotionUpliftPct: 0,
    stockBase: 0,
    coverDays: 7,
    nextOrderBase: (i + 1) * 3,
  },
}));
test("F-610 actually fits chronological samples and compares unseen holdout against the unchanged rule", () => {
  const fit = trainOrderModel(rows);
  expect(fit.metrics.improvesBaseline).toBe(true);
  expect(fit.metrics.trainCount).toBe(10);
  expect(fit.metrics.holdoutCount).toBe(2);
  expect(
    Math.abs(predictOrder(fit.artifact, rows[11].annotations) - 36),
  ).toBeLessThan(3);
  expect(() =>
    trainOrderModel(rows.map((r) => ({ ...r, split: "train" }))),
  ).toThrow("holdouts");
  const f = {
    historyQuantity: 84,
    offtakeDailyBase: null,
    available: 100,
    observation: { date: "2026-01-13", quantity: 0 },
  };
  const settings = {
    historyDays: 28,
    asOfDate: "2026-01-13",
    nextVisitDays: 7,
    leadTimeDays: 1,
  };
  expect(
    modelSuggestion({ status: "approved", sample: false, ...fit }, f, settings)
      .modelStatus,
  ).toBe("rule_fallback");
  expect(
    modelSuggestion(
      { status: "approved", sample: false, version: 1, ...fit },
      { ...f, offtakeDailyBase: 6 },
      settings,
    ).modelStatus,
  ).toBe("model");
});
test("F-609 configured adapter executes its pinned JSON protocol and refuses another model version", async () => {
  const adapter =
    'const input=await new Response(Bun.stdin.stream()).json();console.log(JSON.stringify({modelVersion:input.modelVersion,detections:[{productCode:"TEST-PROTOCOL-ONLY",confidence:1,box:[0,0,1,1]}]}));';
  const env = {
    SUNPRIDE_SHELF_MODEL_COMMAND: JSON.stringify([
      process.execPath,
      "-e",
      adapter,
    ]),
  };
  const result = await inferShelf(
    new Uint8Array([1, 2, 3]),
    { adapterVersion: "test-protocol/v1" },
    env,
  );
  expect(result.available).toBe(true);
  expect("rows" in result ? result.rows[0].facingCount : 0).toBe(1);
  const wrong = {
    SUNPRIDE_SHELF_MODEL_COMMAND: JSON.stringify([
      process.execPath,
      "-e",
      'console.log(JSON.stringify({modelVersion:"wrong",detections:[]}))',
    ]),
  };
  expect(
    (
      await inferShelf(
        new Uint8Array([1]),
        { adapterVersion: "test-protocol/v1" },
        wrong,
      )
    ).available,
  ).toBe(false);
});
test("F-609 detection evidence produces facing/share suggestions and missing adapters stay unavailable", async () => {
  const result = shelfFacts(
    [
      { productCode: "SAMPLE-A", confidence: 0.9, box: [0, 0, 0.5, 1] },
      { productCode: "SAMPLE-B", confidence: 0.95, box: [0.5, 0, 1, 1] },
    ],
    {
      expectedFacings: { "SAMPLE-A": 2 },
      expectedSlots: [{ productCode: "SAMPLE-A", box: [0, 0, 0.5, 1] }],
    },
  );
  expect(result.planogramCompliancePct).toBe(100);
  expect(result.rows.find((r) => r.productCode === "SAMPLE-A")).toMatchObject({
    facingCount: 1,
    shareOfShelfPct: 50,
    compliant: false,
  });
  expect(() =>
    shelfFacts([{ productCode: "bad", confidence: 1, box: [0, 0, 2, 1] }], {}),
  ).toThrow();
  expect(
    (await inferShelf(new Uint8Array([1]), { adapterVersion: "missing" }, {}))
      .available,
  ).toBe(false);
});
