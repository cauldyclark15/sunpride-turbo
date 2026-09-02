"use client";

import { Button } from "@heroui/react";
import { api } from "@sunpride/backend/api";
import type { Id } from "@sunpride/backend/data-model";
import { StatusPill } from "@sunpride/ui";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useMemo, useState } from "react";

const tabs = [
  ["stock", "Stock control"],
  ["receiving", "Receiving"],
  ["transfers", "Transfers"],
  ["counts", "Stock counts"],
  ["production", "Production"],
  ["controls", "Controls"],
  ["ledger", "Movement ledger"],
] as const;

const inputClass =
  "h-10 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20";

function quantityBase(value: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0)
    throw new Error("Enter a positive quantity");
  return BigInt(Math.round(parsed * 1_000));
}

function countedQuantityBase(value: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new Error("Count must be zero or greater");
  return BigInt(Math.round(parsed * 1_000));
}

function formatTime(value: number) {
  return new Intl.DateTimeFormat("en-PH", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value);
}

function operationErrorMessage(error: unknown) {
  const fallback =
    "We couldn't complete that action. Please try again or contact an administrator.";
  if (!(error instanceof Error)) return fallback;
  const message = error.message.trim();
  if (
    !message ||
    message.startsWith("[CONVEX") ||
    message.includes("Server Error") ||
    message.length > 180
  )
    return fallback;
  return message;
}

function OperationPanel({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-surface p-5 shadow-sm">
      <div className="mb-5 border-l-4 border-accent pl-3">
        <h2 className="font-semibold text-foreground">{title}</h2>
        <p className="mt-1 text-sm text-muted">{description}</p>
      </div>
      {children}
    </section>
  );
}

export function InventoryWorkspace({ setupMessage }: { setupMessage: string }) {
  const [tab, setTab] = useState<(typeof tabs)[number][0]>("stock");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [locationFilter, setLocationFilter] = useState("");
  const [receipt, setReceipt] = useState({
    productId: "",
    locationId: "",
    quantity: "10",
    lotNumber: "",
    expiresAt: "",
  });
  const [transfer, setTransfer] = useState({
    productId: "",
    sourceId: "",
    destinationId: "",
    quantity: "10",
  });
  const [countSessionId, setCountSessionId] = useState("");
  const [countValues, setCountValues] = useState<Record<string, string>>({});

  const products = useQuery(api.domains.masterData.products, { limit: 100 });
  const locations = useQuery(api.inventory.queries.locations, {});
  const overview = useQuery(api.inventory.queries.overview, {
    ...(locationFilter
      ? { locationId: locationFilter as Id<"inventoryLocations"> }
      : {}),
    limit: 250,
  });
  const receipts = useQuery(api.inventory.receipts.list, { limit: 25 });
  const transfers = useQuery(api.inventory.transfers.list, { limit: 25 });
  const counts = useQuery(api.inventory.counts.list, { limit: 25 });
  const countDetail = useQuery(
    api.inventory.counts.detail,
    countSessionId
      ? { sessionId: countSessionId as Id<"stockCountSessions"> }
      : "skip",
  );
  const production = useQuery(api.inventory.manufacturing.list, { limit: 25 });
  const adjustments = useQuery(api.inventory.adjustments.list, { limit: 25 });
  const replenishment = useQuery(api.inventory.replenishment.suggestions, {});
  const reconciliationRuns = useQuery(api.inventory.reconciliation.runs, {
    limit: 10,
  });
  const movements = usePaginatedQuery(
    api.inventory.queries.movements,
    {},
    { initialNumItems: 25 },
  );
  const provision = useMutation(api.inventory.setup.foundation);
  const postReceipt = useMutation(api.inventory.receipts.post);
  const requestTransfer = useMutation(api.inventory.transfers.request);
  const approveTransfer = useMutation(api.inventory.transfers.approve);
  const shipTransfer = useMutation(api.inventory.transfers.ship);
  const receiveTransfer = useMutation(api.inventory.transfers.receive);
  const startCount = useMutation(api.inventory.counts.start);
  const submitCount = useMutation(api.inventory.counts.submit);
  const approveCount = useMutation(api.inventory.counts.approveAndPost);
  const runReconciliation = useMutation(api.inventory.reconciliation.run);

  const inventoryReady =
    Boolean(locations?.length) &&
    Boolean(products?.length) &&
    products!.every(
      (product) =>
        product.baseUomId !== undefined &&
        product.quantityScale !== undefined &&
        product.trackingMode !== undefined &&
        product.allocationPolicy !== undefined,
    );
  const displayedNotice =
    notice ??
    (inventoryReady
      ? "Inventory is ready. Locations, units, and product rules are configured."
      : setupMessage);

  const inTransit = locations?.find(
    (location) => location.type === "in_transit",
  );
  const totals = useMemo(
    () =>
      (overview ?? []).reduce(
        (sum, row) => ({
          physical: sum.physical + Number(row.physical),
          available: sum.available + Number(row.available),
          reserved: sum.reserved + Number(row.reserved),
          quality: sum.quality + Number(row.qualityHold),
        }),
        { physical: 0, available: 0, reserved: 0, quality: 0 },
      ),
    [overview],
  );

  async function execute(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    try {
      await action();
      setNotice(success);
    } catch (error) {
      console.error(error);
      setNotice(operationErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function setupInventory() {
    setBusy(true);
    setNotice("Setting up inventory locations, units, and product rules…");
    try {
      const result = await provision();
      setNotice(
        result.seeded
          ? `Inventory setup is complete. ${result.locationCount} locations and ${result.policyCount} product ${result.policyCount === 1 ? "rule" : "rules"} are ready.`
          : "Inventory setup was already complete. No changes were needed.",
      );
    } catch (error) {
      console.error(error);
      setNotice(
        "Inventory setup couldn't be completed. Please try again or contact an administrator.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-5">
      <div className="inventory-command-bar">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted">
            Inventory setup
          </p>
          <p className="mt-1 text-sm text-foreground">{displayedNotice}</p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          isPending={busy}
          isDisabled={busy || inventoryReady}
          onPress={() => void setupInventory()}
        >
          {inventoryReady ? "Inventory ready" : "Set up inventory"}
        </Button>
      </div>

      <div className="flex gap-1 overflow-x-auto rounded-lg border border-border bg-surface p-1">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`shrink-0 rounded-md px-4 py-2 text-sm font-medium transition ${
              tab === id
                ? "bg-foreground text-background shadow-sm"
                : "text-muted hover:bg-background hover:text-foreground"
            }`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "stock" ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[
              ["Physical", totals.physical],
              ["Available to promise", totals.available],
              ["Hard reserved", totals.reserved],
              ["Quality hold", totals.quality],
            ].map(([label, value]) => (
              <div key={label} className="inventory-tally">
                <span>{label}</span>
                <strong>{Number(value).toLocaleString("en-PH")}</strong>
                <small>base cases across filtered locations</small>
              </div>
            ))}
          </div>
          <OperationPanel
            title="Product-location balance"
            description="Physical identity is preserved by lot; this is the fast operational summary."
          >
            <div className="mb-4 max-w-sm">
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted">
                Location
              </label>
              <select
                className={inputClass}
                value={locationFilter}
                onChange={(event) => setLocationFilter(event.target.value)}
              >
                <option value="">All operational locations</option>
                {(locations ?? []).map((location) => (
                  <option key={location._id} value={location._id}>
                    {location.code} — {location.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="overflow-x-auto">
              <table className="inventory-table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Location</th>
                    <th>Physical</th>
                    <th>Reserved</th>
                    <th>Available</th>
                    <th>Hold</th>
                    <th>Version</th>
                  </tr>
                </thead>
                <tbody>
                  {(overview ?? []).map((row) => (
                    <tr key={row.id}>
                      <td>
                        <strong>{row.productCode}</strong>
                        <small>{row.productName}</small>
                      </td>
                      <td>
                        {row.locationCode}
                        <small>{row.locationType.replaceAll("_", " ")}</small>
                      </td>
                      <td>{row.physical}</td>
                      <td>{row.reserved}</td>
                      <td className="font-semibold text-success">
                        {row.available}
                      </td>
                      <td>{row.qualityHold}</td>
                      <td>v{row.version}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </OperationPanel>
        </>
      ) : null}

      {tab === "receiving" ? (
        <div className="grid gap-4 xl:grid-cols-[0.8fr_1.2fr]">
          <OperationPanel
            title="Post goods receipt"
            description="Creates the document, lot, movement, ledger, balances, audit, and SAP effect atomically."
          >
            <div className="grid gap-3">
              <select
                className={inputClass}
                value={receipt.productId}
                onChange={(event) =>
                  setReceipt({ ...receipt, productId: event.target.value })
                }
              >
                <option value="">Select product</option>
                {(products ?? []).map((product) => (
                  <option key={product._id} value={product._id}>
                    {product.code} — {product.name}
                  </option>
                ))}
              </select>
              <select
                className={inputClass}
                value={receipt.locationId}
                onChange={(event) =>
                  setReceipt({ ...receipt, locationId: event.target.value })
                }
              >
                <option value="">Receiving location</option>
                {(locations ?? [])
                  .filter((location) => location.allowsReceiving)
                  .map((location) => (
                    <option key={location._id} value={location._id}>
                      {location.code} — {location.name}
                    </option>
                  ))}
              </select>
              <input
                className={inputClass}
                aria-label="Quantity in cases"
                value={receipt.quantity}
                onChange={(event) =>
                  setReceipt({ ...receipt, quantity: event.target.value })
                }
                placeholder="Accepted cases"
              />
              <input
                className={inputClass}
                aria-label="Lot number"
                value={receipt.lotNumber}
                onChange={(event) =>
                  setReceipt({ ...receipt, lotNumber: event.target.value })
                }
                placeholder="Supplier or production lot"
              />
              <input
                className={inputClass}
                type="date"
                aria-label="Expiry date"
                value={receipt.expiresAt}
                onChange={(event) =>
                  setReceipt({ ...receipt, expiresAt: event.target.value })
                }
              />
              <Button
                variant="primary"
                isPending={busy}
                isDisabled={
                  !receipt.productId ||
                  !receipt.locationId ||
                  !receipt.lotNumber ||
                  !receipt.expiresAt
                }
                onPress={() =>
                  void execute(
                    () =>
                      postReceipt({
                        idempotencyKey: crypto.randomUUID(),
                        receiptType: "purchase_order",
                        receivingLocationId:
                          receipt.locationId as Id<"inventoryLocations">,
                        deliveryReference: `WEB-${Date.now()}`,
                        lines: [
                          {
                            productId: receipt.productId as Id<"products">,
                            quantityBase: quantityBase(receipt.quantity),
                            lotNumber: receipt.lotNumber,
                            manufacturedAt: Date.now(),
                            expiresAt: new Date(receipt.expiresAt).getTime(),
                          },
                        ],
                      }),
                    "Goods receipt posted and queued for SAP acknowledgement.",
                  )
                }
              >
                Post receipt
              </Button>
            </div>
          </OperationPanel>
          <DocumentList
            title="Recent receipts"
            rows={(receipts ?? []).map((row) => ({
              id: row._id,
              number: row.receiptNumber,
              status: row.status,
              time: row.createdAt,
            }))}
          />
        </div>
      ) : null}

      {tab === "transfers" ? (
        <div className="grid gap-4 xl:grid-cols-[0.8fr_1.2fr]">
          <OperationPanel
            title="Request stock transfer"
            description="Shipment moves exact lots into transit; receipt preserves those allocations at destination."
          >
            <div className="grid gap-3">
              <select
                className={inputClass}
                value={transfer.productId}
                onChange={(event) =>
                  setTransfer({ ...transfer, productId: event.target.value })
                }
              >
                <option value="">Select product</option>
                {(products ?? []).map((product) => (
                  <option key={product._id} value={product._id}>
                    {product.code} — {product.name}
                  </option>
                ))}
              </select>
              {(["sourceId", "destinationId"] as const).map((field) => (
                <select
                  key={field}
                  className={inputClass}
                  value={transfer[field]}
                  onChange={(event) =>
                    setTransfer({ ...transfer, [field]: event.target.value })
                  }
                >
                  <option value="">
                    {field === "sourceId"
                      ? "Source location"
                      : "Destination location"}
                  </option>
                  {(locations ?? [])
                    .filter((location) => location.type !== "in_transit")
                    .map((location) => (
                      <option key={location._id} value={location._id}>
                        {location.code} — {location.name}
                      </option>
                    ))}
                </select>
              ))}
              <input
                className={inputClass}
                aria-label="Transfer quantity in cases"
                value={transfer.quantity}
                onChange={(event) =>
                  setTransfer({ ...transfer, quantity: event.target.value })
                }
              />
              <Button
                variant="primary"
                isPending={busy}
                isDisabled={
                  !transfer.productId ||
                  !transfer.sourceId ||
                  !transfer.destinationId ||
                  !inTransit
                }
                onPress={() =>
                  void execute(
                    () =>
                      requestTransfer({
                        sourceLocationId:
                          transfer.sourceId as Id<"inventoryLocations">,
                        destinationLocationId:
                          transfer.destinationId as Id<"inventoryLocations">,
                        inTransitLocationId: inTransit!._id,
                        lines: [
                          {
                            productId: transfer.productId as Id<"products">,
                            quantityBase: quantityBase(transfer.quantity),
                          },
                        ],
                      }),
                    "Transfer requested. A different authorized user must approve it.",
                  )
                }
              >
                Request transfer
              </Button>
            </div>
          </OperationPanel>
          <OperationPanel
            title="Transfer queue"
            description="The control sequence is request → approve → ship → receive."
          >
            <div className="grid gap-2">
              {(transfers ?? []).map((row) => (
                <div key={row._id} className="inventory-document-row">
                  <div>
                    <strong>{row.transferNumber}</strong>
                    <small>{formatTime(row.createdAt)}</small>
                  </div>
                  <StatusPill
                    tone={row.status === "received" ? "success" : "warning"}
                  >
                    {row.status.replaceAll("_", " ")}
                  </StatusPill>
                  <div className="flex flex-wrap justify-end gap-1">
                    {row.status === "requested" ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        onPress={() =>
                          void execute(
                            () => approveTransfer({ transferId: row._id }),
                            "Transfer approved.",
                          )
                        }
                      >
                        Approve
                      </Button>
                    ) : null}
                    {row.status === "approved" ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        onPress={() =>
                          void execute(
                            () =>
                              shipTransfer({
                                transferId: row._id,
                                idempotencyKey: crypto.randomUUID(),
                              }),
                            "Transfer shipped into transit.",
                          )
                        }
                      >
                        Ship
                      </Button>
                    ) : null}
                    {row.status === "shipped" ? (
                      <Button
                        size="sm"
                        variant="primary"
                        onPress={() =>
                          void execute(
                            () =>
                              receiveTransfer({
                                transferId: row._id,
                                idempotencyKey: crypto.randomUUID(),
                              }),
                            "Transfer received with exact lot identity.",
                          )
                        }
                      >
                        Receive
                      </Button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </OperationPanel>
        </div>
      ) : null}

      {tab === "counts" ? (
        <OperationPanel
          title="Controlled stock counts"
          description="A blind snapshot freezes the expected quantities; another authorized user approves any adjustment."
        >
          <div className="mb-5 flex flex-wrap gap-2">
            {(locations ?? [])
              .filter((location) => location.type !== "virtual_boundary")
              .map((location) => (
                <Button
                  key={location._id}
                  size="sm"
                  variant="secondary"
                  isPending={busy}
                  onPress={() =>
                    void execute(
                      () =>
                        startCount({
                          locationId: location._id,
                          countType:
                            location.type === "truck" ? "route_close" : "cycle",
                          blindCount: true,
                        }),
                      `Blind count started for ${location.code}.`,
                    )
                  }
                >
                  Count {location.code}
                </Button>
              ))}
          </div>
          <div className="grid gap-4 lg:grid-cols-[0.7fr_1.3fr]">
            <div>
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
                Count sessions
              </h3>
              <div className="grid gap-2">
                {(counts ?? []).map((row) => (
                  <button
                    key={row._id}
                    type="button"
                    className={`inventory-document-row text-left ${countSessionId === row._id ? "border-accent" : ""}`}
                    onClick={() => {
                      setCountSessionId(row._id);
                      setCountValues({});
                    }}
                  >
                    <div>
                      <strong>{row.countNumber}</strong>
                      <small>{formatTime(row.createdAt)}</small>
                    </div>
                    <StatusPill
                      tone={row.status === "posted" ? "success" : "warning"}
                    >
                      {row.status}
                    </StatusPill>
                  </button>
                ))}
              </div>
            </div>
            <div className="rounded-lg border border-border bg-background p-4">
              {!countDetail ? (
                <p className="text-sm text-muted">
                  Select a count session to enter or review quantities.
                </p>
              ) : (
                <div className="grid gap-3">
                  {countDetail.lines.map((line) => (
                    <div
                      key={line.lineId}
                      className="grid gap-2 border-b border-border pb-3 sm:grid-cols-[1fr_10rem] sm:items-end"
                    >
                      <div>
                        <strong className="text-sm">{line.productCode}</strong>
                        <small className="block text-muted">
                          {line.productName}
                          {line.lotNumber ? ` · lot ${line.lotNumber}` : ""}
                          {line.systemBase !== undefined
                            ? ` · system ${Number(line.systemBase) / 1_000}`
                            : " · blind count"}
                        </small>
                      </div>
                      <input
                        className={inputClass}
                        type="number"
                        min="0"
                        step="0.001"
                        aria-label={`Counted quantity for ${line.productCode}`}
                        disabled={countDetail.session.status !== "counting"}
                        value={
                          countValues[line.lineId] ??
                          (line.countedBase !== undefined
                            ? String(Number(line.countedBase) / 1_000)
                            : "")
                        }
                        onChange={(event) =>
                          setCountValues({
                            ...countValues,
                            [line.lineId]: event.target.value,
                          })
                        }
                        placeholder="Counted cases"
                      />
                    </div>
                  ))}
                  {countDetail.session.status === "counting" ? (
                    <Button
                      variant="primary"
                      isPending={busy}
                      isDisabled={countDetail.lines.some(
                        (line) => !countValues[line.lineId],
                      )}
                      onPress={() =>
                        void execute(
                          () =>
                            submitCount({
                              sessionId: countDetail.session._id,
                              lines: countDetail.lines.map((line) => ({
                                lineId: line.lineId,
                                countedBase: countedQuantityBase(
                                  countValues[line.lineId] ?? "0",
                                ),
                              })),
                            }),
                          "Count submitted for independent approval.",
                        )
                      }
                    >
                      Submit blind count
                    </Button>
                  ) : null}
                  {countDetail.session.status === "submitted" ? (
                    <Button
                      variant="primary"
                      isPending={busy}
                      onPress={() =>
                        void execute(
                          () =>
                            approveCount({
                              sessionId: countDetail.session._id,
                              idempotencyKey: crypto.randomUUID(),
                              reasonCode: "verified_stock_count",
                            }),
                          "Count variance approved and posted.",
                        )
                      }
                    >
                      Approve and post variance
                    </Button>
                  ) : null}
                </div>
              )}
            </div>
          </div>
        </OperationPanel>
      ) : null}

      {tab === "production" ? (
        <OperationPanel
          title="Production control"
          description="Released orders pin a BOM version; completion consumes exact component lots and creates an output lot with genealogy."
        >
          <DocumentList
            title="Production orders"
            rows={(production ?? []).map((row) => ({
              id: row._id,
              number: row.productionOrderNumber,
              status: row.status,
              time: row.createdAt,
            }))}
            empty="No production orders have been released. Create and approve a BOM version through the manufacturing API before production."
          />
        </OperationPanel>
      ) : null}

      {tab === "controls" ? (
        <div className="grid gap-4 xl:grid-cols-3">
          <OperationPanel
            title="Replenishment exceptions"
            description="Enabled min/target policies produce suggestions without creating stock by themselves."
          >
            <div className="grid gap-2">
              {(replenishment ?? []).map((row) => (
                <div key={row.policyId} className="inventory-document-row">
                  <div>
                    <strong>{row.productCode}</strong>
                    <small>
                      {row.locationCode ?? "All locations"} · suggested{" "}
                      {Number(row.suggestedBase) / 1_000}
                    </small>
                  </div>
                  <StatusPill tone="warning">low</StatusPill>
                </div>
              ))}
              {replenishment?.length === 0 ? (
                <p className="text-sm text-muted">No low-stock exceptions.</p>
              ) : null}
            </div>
          </OperationPanel>
          <OperationPanel
            title="Adjustment approvals"
            description="Manual corrections are requested first and must be posted by another authorized user."
          >
            <DocumentList
              title="Recent adjustments"
              rows={(adjustments ?? []).map((row) => ({
                id: row._id,
                number: row.adjustmentNumber,
                status: row.status,
                time: row.createdAt,
              }))}
            />
          </OperationPanel>
          <OperationPanel
            title="SAP reconciliation"
            description="Compares operational balances to snapshots at an explicit cutoff; it never overwrites stock."
          >
            <Button
              variant="secondary"
              isPending={busy}
              onPress={() =>
                void execute(
                  () => runReconciliation({ sapCutoff: Date.now() }),
                  "Reconciliation completed. Review any open differences.",
                )
              }
            >
              Reconcile current snapshot
            </Button>
            <div className="mt-4 grid gap-2">
              {(reconciliationRuns ?? []).map((row) => (
                <div key={row._id} className="inventory-document-row">
                  <div>
                    <strong>{row.scope}</strong>
                    <small>
                      {row.comparedCount} compared · {row.differenceCount}{" "}
                      differences
                    </small>
                  </div>
                  <StatusPill
                    tone={row.differenceCount === 0 ? "success" : "warning"}
                  >
                    {row.status}
                  </StatusPill>
                </div>
              ))}
            </div>
          </OperationPanel>
        </div>
      ) : null}

      {tab === "ledger" ? (
        <OperationPanel
          title="Immutable movement ledger"
          description="Every row links back to a command, document, exact allocations, balance versions, audit record, and SAP effect."
        >
          <div className="grid gap-2">
            {movements.results.map((row) => (
              <div key={row._id} className="inventory-document-row">
                <div>
                  <strong>{row.movementNumber}</strong>
                  <small>
                    {row.sourceType.replaceAll("_", " ")} ·{" "}
                    {formatTime(row.postedAt)}
                  </small>
                </div>
                <span className="text-sm font-medium">
                  {row.movementType.replaceAll("_", " ")}
                </span>
                <StatusPill
                  tone={row.status === "posted" ? "success" : "neutral"}
                >
                  {row.status}
                </StatusPill>
              </div>
            ))}
          </div>
          {movements.status === "CanLoadMore" ? (
            <Button
              className="mt-4"
              size="sm"
              variant="secondary"
              onPress={() => movements.loadMore(25)}
            >
              Load more
            </Button>
          ) : null}
        </OperationPanel>
      ) : null}
    </div>
  );
}

function DocumentList({
  title,
  rows,
  empty = "No records yet.",
}: {
  title: string;
  rows: { id: string; number: string; status: string; time: number }[];
  empty?: string;
}) {
  return (
    <div>
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-muted">
        {title}
      </h3>
      <div className="grid gap-2">
        {rows.length === 0 ? (
          <p className="rounded-lg bg-background p-4 text-sm text-muted">
            {empty}
          </p>
        ) : null}
        {rows.map((row) => (
          <div key={row.id} className="inventory-document-row">
            <div>
              <strong>{row.number}</strong>
              <small>{formatTime(row.time)}</small>
            </div>
            <StatusPill
              tone={
                row.status === "posted" ||
                row.status === "received" ||
                row.status === "completed"
                  ? "success"
                  : "warning"
              }
            >
              {row.status.replaceAll("_", " ")}
            </StatusPill>
          </div>
        ))}
      </div>
    </div>
  );
}
