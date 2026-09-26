"use client";

import { Button, Input, ListBox, Select } from "@heroui/react";
import { api } from "@sunpride/backend/api";
import type { Id } from "@sunpride/backend/data-model";
import {
  Card,
  ListRow,
  MetricCard,
  Notice,
  PageHeader,
  StatusPill,
  UnderlineTabs,
  WorkspaceIcon,
} from "@sunpride/ui";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useMemo, useState } from "react";

const tabs = [
  ["stock", "Stock control"],
  ["receiving", "Receiving"],
  ["transfers", "Transfers"],
  ["counts", "Stock counts"],
  ["production", "Production"],
  ["controls", "Controls"],
  ["ledger", "Movements"],
] as const;

const inputClass =
  "h-10 w-full rounded-[10px] border border-field-border bg-field-background px-3 text-sm shadow-none";

function InventorySelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { id: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <Select
      aria-label={label}
      selectedKey={value || "__none"}
      onSelectionChange={(key) =>
        onChange(key === "__none" ? "" : String(key ?? ""))
      }
    >
      <Select.Trigger className="h-10 min-h-10 rounded-[10px] !border !border-border bg-surface px-3 text-sm shadow-none">
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {options.map((option) => (
            <ListBox.Item
              key={option.id || "__none"}
              id={option.id || "__none"}
              textValue={option.label}
            >
              {option.label}
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

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
  const fallback = "Action failed. Try again.";
  if (!(error instanceof Error)) return fallback;
  const message = error.message.trim();
  return message === "Enter a positive quantity" ||
    message === "Count must be zero or greater"
    ? message
    : fallback;
}

function OperationPanel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card label={title} icon={<WorkspaceIcon name="inventory" />}>
      {children}
    </Card>
  );
}

export function InventoryWorkspace({ setupMessage }: { setupMessage: string }) {
  void setupMessage;
  const [tab, setTab] = useState<(typeof tabs)[number][0]>("stock");
  const [notice, setNotice] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
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
    (!inventoryReady && locations && products
      ? "Set up inventory to continue"
      : null);

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
      setNotice(null);
      setToast(success);
      window.setTimeout(() => setToast(null), 4000);
    } catch (error) {
      console.error(error);
      setNotice(operationErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function setupInventory() {
    setBusy(true);
    setNotice(null);
    try {
      await provision();
      setNotice(null);
      setToast("Inventory set up");
      window.setTimeout(() => setToast(null), 4000);
    } catch (error) {
      console.error(error);
      setNotice("Setup failed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4">
      <PageHeader
        title="Inventory"
        meta={
          overview && locations
            ? `${totals.physical.toLocaleString("en-PH")} cases · ${locations.length} ${locations.length === 1 ? "location" : "locations"}`
            : undefined
        }
      />
      {toast ? (
        <div
          role="status"
          className="fixed bottom-4 right-4 z-50 rounded-xl bg-overlay px-4 py-3 text-[13px] text-overlay-foreground shadow-overlay"
        >
          {toast}
        </div>
      ) : null}
      {displayedNotice ? (
        <Notice
          title={displayedNotice}
          tone={notice ? "danger" : "warning"}
          meta={
            !inventoryReady ? (
              <Button
                variant="secondary"
                className="mt-2 h-8 min-h-8"
                isPending={busy}
                onPress={() => void setupInventory()}
              >
                Set up
              </Button>
            ) : undefined
          }
        />
      ) : null}
      <UnderlineTabs
        items={tabs}
        activeId={tab}
        onChange={setTab}
        label="Inventory sections"
      />

      {tab === "stock" ? (
        <>
          <section aria-label="Stock · cases">
            <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">
              Stock · cases
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {[
                ["Physical", totals.physical],
                ["Available", totals.available],
                ["Reserved", totals.reserved],
                ["Hold", totals.quality],
              ].map(([label, value]) => (
                <MetricCard
                  key={label}
                  label={String(label)}
                  value={Number(value).toLocaleString("en-PH")}
                />
              ))}
            </div>
          </section>
          <Card
            label="Stock by location"
            icon={<WorkspaceIcon name="inventory" />}
            flush
            actions={
              <div className="w-56">
                <InventorySelect
                  label="Location"
                  value={locationFilter}
                  onChange={setLocationFilter}
                  options={[
                    { id: "", label: "All locations" },
                    ...(locations ?? []).map((location) => ({
                      id: location._id,
                      label: `${location.code} · ${location.name}`,
                    })),
                  ]}
                />
              </div>
            }
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] border-collapse [&_tbody_tr:last-child_td]:border-b-0 text-left text-sm [&_th]:border-b [&_th]:border-separator [&_th]:px-4 [&_th]:py-3 [&_th]:text-[11px] [&_th]:font-medium [&_th]:uppercase [&_th]:tracking-wide [&_th]:text-muted [&_td]:h-[52px] [&_td]:border-b [&_td]:border-separator [&_td]:px-4 [&_td]:py-2">
                <thead>
                  <tr>
                    <th className="w-1/2">Product</th>
                    <th>Location</th>
                    <th className="text-right">Physical</th>
                    <th className="text-right">Available</th>
                    <th className="text-right">Reserved</th>
                    <th className="text-right">Hold</th>
                  </tr>
                </thead>
                <tbody>
                  {(overview ?? []).map((row) => (
                    <tr key={row.id}>
                      <td>
                        <span className="block font-medium">
                          {row.productName}
                        </span>
                        <span className="block font-mono text-xs text-muted">
                          {row.productCode}
                        </span>
                      </td>
                      <td>
                        <span className="block">{row.locationCode}</span>
                        <span className="block text-xs text-muted">
                          {row.locationType.replaceAll("_", " ")}
                        </span>
                      </td>
                      <td className="text-right tabular-nums">
                        {row.physical}
                      </td>
                      <td className="text-right tabular-nums">
                        {row.available}
                      </td>
                      <td className="text-right tabular-nums">
                        {row.reserved}
                      </td>
                      <td className="text-right tabular-nums">
                        {row.qualityHold}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      ) : null}

      {tab === "receiving" ? (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <OperationPanel title="Receive stock">
            <div className="grid gap-3">
              <InventorySelect
                label="Product"
                value={receipt.productId}
                onChange={(productId) => setReceipt({ ...receipt, productId })}
                options={[
                  { id: "", label: "Select product" },
                  ...(products ?? []).map((product) => ({
                    id: product._id,
                    label: `${product.code} · ${product.name}`,
                  })),
                ]}
              />
              <InventorySelect
                label="Receiving location"
                value={receipt.locationId}
                onChange={(locationId) =>
                  setReceipt({ ...receipt, locationId })
                }
                options={[
                  { id: "", label: "Receiving location" },
                  ...(locations ?? [])
                    .filter((location) => location.allowsReceiving)
                    .map((location) => ({
                      id: location._id,
                      label: `${location.code} · ${location.name}`,
                    })),
                ]}
              />
              <Input
                className={inputClass}
                aria-label="Quantity in cases"
                value={receipt.quantity}
                onChange={(event) =>
                  setReceipt({ ...receipt, quantity: event.target.value })
                }
                placeholder="Accepted cases"
              />
              <Input
                className={inputClass}
                aria-label="Lot number"
                value={receipt.lotNumber}
                onChange={(event) =>
                  setReceipt({ ...receipt, lotNumber: event.target.value })
                }
                placeholder="Supplier or production lot"
              />
              <Input
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
                    "Receipt posted",
                  )
                }
              >
                Post receipt
              </Button>
            </div>
          </OperationPanel>
          <Card
            label="Recent receipts"
            icon={<WorkspaceIcon name="inventory" />}
          >
            <DocumentList
              title=""
              rows={(receipts ?? []).map((row) => ({
                id: row._id,
                number: row.receiptNumber,
                status: row.status,
                time: row.createdAt,
              }))}
            />
          </Card>
        </div>
      ) : null}

      {tab === "transfers" ? (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <OperationPanel title="New transfer">
            <div className="grid gap-3">
              <InventorySelect
                label="Product"
                value={transfer.productId}
                onChange={(productId) =>
                  setTransfer({ ...transfer, productId })
                }
                options={[
                  { id: "", label: "Select product" },
                  ...(products ?? []).map((product) => ({
                    id: product._id,
                    label: `${product.code} · ${product.name}`,
                  })),
                ]}
              />
              {(["sourceId", "destinationId"] as const).map((field) => (
                <InventorySelect
                  key={field}
                  label={
                    field === "sourceId"
                      ? "Source location"
                      : "Destination location"
                  }
                  value={transfer[field]}
                  onChange={(value) =>
                    setTransfer({ ...transfer, [field]: value })
                  }
                  options={[
                    {
                      id: "",
                      label:
                        field === "sourceId"
                          ? "Source location"
                          : "Destination location",
                    },
                    ...(locations ?? [])
                      .filter((location) => location.type !== "in_transit")
                      .map((location) => ({
                        id: location._id,
                        label: `${location.code} · ${location.name}`,
                      })),
                  ]}
                />
              ))}
              <Input
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
                    "Transfer requested",
                  )
                }
              >
                Request transfer
              </Button>
            </div>
          </OperationPanel>
          <OperationPanel title="Transfer queue">
            <div className="grid gap-2">
              {(transfers ?? []).map((row) => (
                <div
                  key={row._id}
                  className="grid min-h-14 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-separator px-4 last:border-b-0"
                >
                  <div>
                    <strong className="font-mono text-sm font-medium">
                      {row.transferNumber}
                    </strong>
                    <small className="block text-[13px] text-muted">
                      {formatTime(row.createdAt)}
                    </small>
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
                            "Transfer shipped",
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
                            "Transfer received",
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
        <OperationPanel title="Stock counts">
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
                      "Count started",
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
                    className={`flex min-h-14 w-full items-center justify-between gap-3 border-b border-separator px-4 text-left last:border-b-0 ${countSessionId === row._id ? "bg-accent-soft" : ""}`}
                    onClick={() => {
                      setCountSessionId(row._id);
                      setCountValues({});
                    }}
                  >
                    <div>
                      <strong className="font-mono text-sm font-medium">
                        {row.countNumber}
                      </strong>
                      <small className="block text-[13px] text-muted">
                        {formatTime(row.createdAt)}
                      </small>
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
            <div className="p-4">
              {!countDetail ? (
                <p className="text-sm text-muted">Select a count to review</p>
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
                      <Input
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
                          "Count submitted",
                        )
                      }
                    >
                      Submit count
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
                          "Count posted",
                        )
                      }
                    >
                      Approve count
                    </Button>
                  ) : null}
                </div>
              )}
            </div>
          </div>
        </OperationPanel>
      ) : null}

      {tab === "production" ? (
        <OperationPanel title="Production">
          <DocumentList
            title="Production orders"
            rows={(production ?? []).map((row) => ({
              id: row._id,
              number: row.productionOrderNumber,
              status: row.status,
              time: row.createdAt,
            }))}
            empty="No production orders yet"
          />
        </OperationPanel>
      ) : null}

      {tab === "controls" ? (
        <div className="grid gap-4 xl:grid-cols-3">
          <OperationPanel title="Low stock">
            <div className="grid gap-2">
              {(replenishment ?? []).map((row) => (
                <div
                  key={row.policyId}
                  className="grid min-h-14 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-separator px-4 last:border-b-0"
                >
                  <div>
                    <strong className="font-mono text-sm font-medium">
                      {row.productCode}
                    </strong>
                    <small className="block text-[13px] text-muted">
                      {row.locationCode ?? "All locations"} · suggested{" "}
                      {Number(row.suggestedBase) / 1_000}
                    </small>
                  </div>
                  <StatusPill tone="warning">low</StatusPill>
                </div>
              ))}
              {replenishment?.length === 0 ? (
                <p className="text-sm text-muted">No low stock</p>
              ) : null}
            </div>
          </OperationPanel>
          <OperationPanel title="Adjustments">
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
          <OperationPanel title="Differences">
            <Button
              variant="secondary"
              isPending={busy}
              onPress={() =>
                void execute(
                  () => runReconciliation({ sapCutoff: Date.now() }),
                  "Check differences",
                )
              }
            >
              Check differences
            </Button>
            <div className="mt-4 grid gap-2">
              {(reconciliationRuns ?? []).map((row) => (
                <div
                  key={row._id}
                  className="grid min-h-14 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-separator px-4 last:border-b-0"
                >
                  <div>
                    <strong className="text-sm font-medium">{row.scope}</strong>
                    <small className="block text-[13px] text-muted">
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
        <OperationPanel title="Movements">
          <div className="grid gap-2">
            {movements.results.map((row) => (
              <div
                key={row._id}
                className="grid min-h-14 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-separator px-4 last:border-b-0"
              >
                <div>
                  <strong className="font-mono text-sm font-medium">
                    {row.movementNumber}
                  </strong>
                  <small className="block text-[13px] text-muted">
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
  empty = "No records yet",
}: {
  title: string;
  rows: { id: string; number: string; status: string; time: number }[];
  empty?: string;
}) {
  return (
    <div>
      {title ? (
        <h3 className="mb-3 text-[11px] font-medium uppercase tracking-wide text-muted">
          {title}
        </h3>
      ) : null}
      <div className="-mx-4 -mb-4">
        {rows.length === 0 ? (
          <p className="rounded-lg bg-background p-4 text-sm text-muted">
            {empty}
          </p>
        ) : null}
        {rows.map((row) => (
          <ListRow
            key={row.id}
            icon={<WorkspaceIcon name="inventory" />}
            title={<span className="font-mono">{row.number}</span>}
            meta={formatTime(row.time)}
            action={
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
            }
          />
        ))}
      </div>
    </div>
  );
}
