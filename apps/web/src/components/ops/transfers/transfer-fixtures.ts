import type { TransferLine } from "./transfer-model";

/** A 10-case line with one batch, sent and nothing received yet. For tests and previews. */
export const line = (o: Partial<TransferLine> = {}): TransferLine => ({
  id: "l1",
  productId: "p1",
  code: "LONG-500",
  name: "Longganisa 500 g",
  stockStatus: "available",
  basePerCase: 48,
  requestedBase: 480,
  approvedBase: 480,
  pickedBase: 480,
  dispatchedBase: 480,
  receivedGoodBase: 0,
  receivedDamagedBase: 0,
  receivedHoldBase: 0,
  shortBase: 0,
  overBase: 0,
  reasonCode: null,
  allocations: [
    {
      id: "a1",
      batchId: "b1",
      batch: "B-100",
      expiresAt: Date.UTC(2027, 0, 1),
      held: false,
      dispatchedBase: 480,
      receivedGoodBase: 0,
      receivedDamagedBase: 0,
      receivedHoldBase: 0,
      remainingBase: 480,
      shortBase: 0,
      overBase: 0,
    },
  ],
  ...o,
});
