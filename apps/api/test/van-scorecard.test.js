import { expect, test } from "bun:test";
import { scorecardMetrics } from "../src/domains/van/scorecard.js";
import {
  settlementState,
  routeNextAction,
} from "../src/domains/van/route-read.js";

test("F-105 F-115 F-117 next actions follow the actual trip and exception stage", () => {
  const route = {
    settlementState: null,
    observations: [],
    cases: [],
    versions: [],
  };
  const empty = { count: null, cash: null, remittance: null };
  expect(routeNextAction({ status: "loading" }, route, empty)).toContain(
    "scan and confirm",
  );
  expect(routeNextAction({ status: "loaded" }, route, empty)).toContain(
    "opening odometer",
  );
  expect(
    routeNextAction(
      { status: "closing" },
      { ...route, settlementState: "approved_pending_sap" },
      empty,
    ),
  ).toContain("acknowledgement is pending");
  expect(
    routeNextAction(
      { status: "active" },
      {
        ...route,
        observations: [
          { kind: "temperature", facts: { excursion: true }, decision: null },
        ],
      },
      empty,
    ),
  ).toContain("Quality review required");
});

test("F-117 F-123 rejection is not pending supervision and only acknowledged SAP posting is posted", () => {
  expect(settlementState(undefined, undefined)).toBeNull();
  expect(settlementState({ decision: null }, undefined)).toBe(
    "pending_supervisor",
  );
  expect(settlementState({ decision: "rejected" }, undefined)).toBe("rejected");
  expect(settlementState({ decision: "approved" }, undefined)).toBe(
    "approved_pending_sap",
  );
  expect(settlementState({ decision: "approved" }, { status: "pending" })).toBe(
    "approved_pending_sap",
  );
  expect(
    settlementState({ decision: "approved" }, { status: "acknowledged" }),
  ).toBe("posted");
});

test("F-122 strike rate uses actual stores, voids never count and credit promises are not collections", () => {
  const card = scorecardMetrics({
    sales: [
      { outletId: "A", totalCentavos: "100", voided: false },
      { outletId: "A", totalCentavos: "200", voided: false },
      { outletId: "B", totalCentavos: "999", voided: true },
    ],
    stops: [
      { outletId: "A", phase: "arrival" },
      { outletId: "A", phase: "departure" },
      { outletId: "B", phase: "arrival" },
    ],
    payments: [
      { method: "cash", kind: "sale_payment", amountCentavos: "300" },
      { method: "credit", kind: "sale_payment", amountCentavos: "500" },
      { method: "cash", kind: "collection", amountCentavos: "100" },
      { method: "cash", kind: "refund", amountCentavos: "50" },
    ],
    returnDocuments: 1,
    varianceCentavos: "0",
    plannedCalls: 3,
  });
  expect(card).toMatchObject({
    salesCentavos: String(100 + 200),
    calls: 2,
    productiveCalls: 1,
    strikeRateBasisPoints: 5000,
    dropSizeCentavos: String(100 + 200),
    returnDocuments: 1,
    collectedCentavos: String(300 + 100 - 50),
    refundsCentavos: "50",
    callFactsComplete: true,
  });
});
test("F-122 a sale is not invented as an actual call when arrival facts are missing", () => {
  const card = scorecardMetrics({
    sales: [{ outletId: "A", totalCentavos: "100", voided: false }],
    stops: [],
    payments: [],
    returnDocuments: 0,
    varianceCentavos: null,
    plannedCalls: 3,
  });
  expect(card).toMatchObject({
    calls: 0,
    strikeRateBasisPoints: null,
    callFactsComplete: false,
    varianceCentavos: null,
  });
});
