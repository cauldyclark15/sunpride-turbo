"use client";
import { useState, useRef, useEffect, useCallback } from "react";
import { CreditDecision, type CreditException } from "./credit-decision";
import type {
  Command,
  Health,
  Order,
  Quote,
  Scorecard,
  Workspace,
} from "./types";
import {
  ActionForm,
  buttonClass,
  Cell,
  Empty,
  Field,
  fieldClass,
  manilaToday,
  MiniMetric,
  money,
  number,
  Panel,
  State,
  Table,
  usePartnerQuery,
  value,
  when,
  words,
} from "./kit";

export function Overview({
  workspace,
  onStock,
  stockAllowed,
}: {
  workspace: Workspace;
  onStock: () => void;
  stockAllowed: boolean;
}) {
  const score = usePartnerQuery<Scorecard>(
      workspace.distributor.id,
      "scorecard",
    ),
    health = usePartnerQuery<Health>(
      workspace.distributor.id,
      "stock-health",
      stockAllowed,
    );
  return (
    <>
      <State query={score}>
        {(s) => (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <MiniMetric
                label="Secondary sales · last 28 days"
                value={money(s.secondaryCentavos)}
                note={`Prior period ${money(s.priorCentavos)} · target ${money(s.targetCentavos)}${s.targetCentavos ? ` · ${Math.round((s.secondaryCentavos / s.targetCentavos) * 100)}% achieved` : ""}`}
              />
              <MiniMetric
                label="Growth against prior period"
                value={
                  s.growthPct === null
                    ? "Unknown"
                    : `${s.growthPct.toFixed(1)}%`
                }
                note="Net retailer invoices less returns; same-length comparison"
              />
              <MiniMetric
                label="Partner scorecard"
                value={
                  s.score === null
                    ? "Incomplete"
                    : `${s.score.toFixed(0)} / 100`
                }
                note={s.nextAction}
              />
            </div>
            <Panel
              title="What needs attention"
              detail="Start with missing declarations, dated stock and incomplete audit evidence."
            >
              <p className="text-sm font-medium">{s.nextAction}</p>
              {stockAllowed ? (
                <div>
                  <button className={buttonClass} onClick={onStock}>
                    Review stock exceptions
                  </button>
                </div>
              ) : null}
              <div className="grid gap-3 sm:grid-cols-4">
                {Object.entries(s.components)
                  .sort((a, b) => (a[1] ?? -1) - (b[1] ?? -1))
                  .map(([k, n]) => (
                    <div key={k} className="border-l-2 border-border pl-3">
                      <p className="text-xs text-muted">
                        {words(k)} · weight {s.weights[k]}%
                      </p>
                      <p className="mt-1 font-medium">
                        {n === null ? "Not measured" : `${n.toFixed(0)} / 100`}
                      </p>
                    </div>
                  ))}
              </div>
              {s.audit ? (
                <p className="text-sm text-muted">
                  Audit {when(s.audit.date)} · {s.audit.findings}
                </p>
              ) : (
                <p className="text-sm text-muted">
                  Channel Development needs to record a capability audit.
                </p>
              )}
            </Panel>
          </>
        )}
      </State>
      {stockAllowed ? (
        <State query={health}>
          {(h) => (
            <Panel
              title="Stock and offtake"
              detail={
                h.stale
                  ? "Stock declaration is missing or stale. Days of inventory stays unknown until stock is current."
                  : `Latest declaration ${when(h.declaration?.date)} · ${h.period.days}-day net offtake window`
              }
            >
              <div className="flex flex-wrap gap-4">
                {h.rows.map((r) => (
                  <div
                    className="min-w-48 flex-1 rounded-lg border border-border p-4"
                    key={r.productId}
                  >
                    <p className="font-medium">{r.name}</p>
                    <p className="mt-2 text-2xl">
                      {r.daysOfInventory === null
                        ? "Unknown"
                        : `${r.daysOfInventory.toFixed(1)} days`}
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      Target {r.targetDays.min}–{r.targetDays.max} days ·{" "}
                      {words(r.status)}
                    </p>
                    <p className="mt-2 text-sm">{r.nextAction}</p>
                  </div>
                ))}
              </div>
              <details>
                <summary className="cursor-pointer text-sm font-medium">
                  Daily secondary-sales trend
                </summary>
                <Table headers={["Date", "Net secondary sales"]}>
                  {h.trend.map((t) => (
                    <tr key={t.date}>
                      <Cell>{when(t.date)}</Cell>
                      <Cell>{money(t.secondaryCentavos)}</Cell>
                    </tr>
                  ))}
                </Table>
              </details>
              <div>
                <button className={buttonClass} onClick={onStock}>
                  Review stock by warehouse and batch
                </button>
              </div>
            </Panel>
          )}
        </State>
      ) : null}
    </>
  );
}
export function PartnerDiscountApproval({
  authority,
  onRequest,
  onRefresh,
}: {
  authority: Quote["authority"];
  onRequest: (reason: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  if (authority?.status !== "approval_required") return null;
  return (
    <>
      <p className="text-sm">
        Finance approval is required before this exact quotation can be ordered.
        Approvers use the existing price and discount authority queue.
      </p>
      {!authority.pendingId ? (
        <ActionForm
          title="Escalate this quotation"
          submitLabel="Request independent Finance approval"
          onSubmit={async (f) => onRequest(value(f, "reason"))}
        >
          <Field label="Reason">
            <input
              name="reason"
              required
              maxLength={160}
              className={fieldClass}
            />
          </Field>
        </ActionForm>
      ) : (
        <p className="text-sm">Your request is waiting for Finance.</p>
      )}
      <ActionForm
        title="Check Finance decision"
        submitLabel="Refresh this quotation"
        onSubmit={onRefresh}
      >
        <p>Stock, credit and exact approval facts are checked again.</p>
      </ActionForm>
    </>
  );
}
export function Ordering({
  workspace,
  command,
  canWrite,
}: {
  workspace: Workspace;
  command: Command;
  canWrite: boolean;
}) {
  const id = workspace.distributor.id,
    orders = usePartnerQuery<{ rows: Order[]; next: string | null }>(
      id,
      "orders",
    );
  const [preview, setPreview] = useState<Quote | null>(null),
    [cart, setCart] = useState<{ productId: string; quantity: number }[]>([]),
    [po, setPo] = useState("");
  const [confirmed, setConfirmed] = useState<Quote | null>(null);
  const [credit, setCredit] = useState<{
    binding: string;
    request: CreditException;
  } | null>(null);
  const [previewOwner, setPreviewOwner] = useState(id);
  const generation = useRef(0);
  const retire = useCallback(() => {
    generation.current++;
  }, []);
  useEffect(() => {
    retire();
    return retire;
  }, [id, canWrite, retire]);
  const binding = JSON.stringify([id, po, cart]);
  const currentCredit = credit?.binding === binding ? credit.request : null;
  return (
    <>
      <p className="text-sm text-muted">
        {workspace.terms.paymentTerms} · delivery lead time{" "}
        {workspace.terms.deliveryLeadDays} days. Stock and credit are checked
        again on confirmation.
      </p>
      {canWrite ? (
        <ActionForm
          title="Raise a primary purchase order"
          submitLabel="Check stock, price and schemes"
          successMessage="Stock, prices and credit checked. Review the quotation before submitting."
          onSubmit={async (f) => {
            const lines = workspace.catalog
              .map((p) => ({
                productId: p.productId,
                quantity: number(f, p.productId),
              }))
              .filter((l) => l.quantity > 0);
            if (!lines.length)
              throw new Error("Enter a quantity for at least one product.");
            const version = ++generation.current;
            setCredit(null);
            setPreview(null);
            setCart(lines);
            const poNumber = value(f, "po");
            setPo(poNumber);
            const quote = (await command("quote", {
              lines,
              poNumber,
            })) as unknown as Quote;
            if (version === generation.current) {
              setPreviewOwner(id);
              setPreview(quote);
            }
          }}
        >
          <Field label="Your purchase order reference">
            <input name="po" required className={fieldClass} />
          </Field>
          <Table headers={["Product", "Price", "Available", "Quantity"]}>
            {workspace.catalog.map((p) => (
              <tr key={p.productId}>
                <Cell>
                  {p.name}
                  <p className="text-xs text-muted">
                    {p.code} · {p.unitsPerUom} pieces per {p.uom}
                  </p>
                </Cell>
                <Cell>
                  {money(p.priceCentavos)} / {p.uom}
                </Cell>
                <Cell>
                  {Math.floor(p.availableBase / p.unitsPerUom)} {p.uom}
                </Cell>
                <Cell>
                  <input
                    name={p.productId}
                    type="number"
                    min="0"
                    max="1000000"
                    defaultValue="0"
                    step="1"
                    aria-label={`Quantity for ${p.name}`}
                    className={`${fieldClass} min-w-24`}
                  />
                </Cell>
              </tr>
            ))}
          </Table>
        </ActionForm>
      ) : null}
      {canWrite && previewOwner === id && preview ? (
        <Panel
          title="Purchase order preview"
          detail="A quotation is not an order. Confirmation refreshes stock and SAP credit."
        >
          <Table headers={["Product", "Quantity", "Net line value", "Stock"]}>
            {preview.lines.map((l) => (
              <tr key={l.productId}>
                <Cell>{l.description}</Cell>
                <Cell>
                  {l.quantity} {l.uom}
                </Cell>
                <Cell>{money(l.lineTotalCentavos)}</Cell>
                <Cell>{l.inStock ? "Available" : "Not enough stock"}</Cell>
              </tr>
            ))}
          </Table>
          <p className="text-xl font-semibold">
            Total {money(preview.totalCentavos)}
          </p>
          <p className="text-sm">
            Credit: {words(preview.credit.status)} ·{" "}
            {preview.credit.authority ?? "SAP adapter"}
          </p>
          {preview.schemes.length ? (
            preview.schemes.map((s) => (
              <p key={s.id} className="text-sm">
                {s.name} ·{" "}
                {!s.eligible
                  ? "Not eligible"
                  : s.applied
                    ? "Benefit applied"
                    : "Eligible; minimums not met or another benefit selected"}{" "}
                · {s.reason}
              </p>
            ))
          ) : (
            <p className="text-sm text-muted">
              No eligible scheme for this cart.
            </p>
          )}
          {preview.benefits.map((b) => (
            <p key={b.name} className="text-sm">
              {b.name}: {money(b.discountCentavos)} discount
              {b.earnedCentavos
                ? ` · ${money(b.earnedCentavos)} deferred rebate (not an invoice discount)`
                : null}
              {b.freeGoods
                .map(
                  (g) =>
                    ` · ${g.quantity} ${g.uom} ${g.productName ?? ""} free`,
                )
                .join("")}
            </p>
          ))}
          {preview.benefits.some(
            (b) => b.discountCentavos > 0 || b.freeGoods.length > 0,
          ) && (
            <ActionForm
              title="Price and discount authority"
              submitLabel="Send exact quotation to Finance"
              successMessage="Review recorded in the existing Finance desk. Confirmation rechecks the current role, channel, value band and decision."
              onSubmit={async () => {
                await command("financial/request", {
                  poNumber: po,
                  lines: cart,
                });
              }}
            >
              <p className="text-sm text-muted">
                Published benefits still require your role's authority. An
                above-limit request needs another authorized person before this
                purchase order can be confirmed.
              </p>
            </ActionForm>
          )}
          {!["within", "no_limit"].includes(preview.credit.status) && (
            <ActionForm
              title="Ask for a credit exception"
              submitLabel="Send to Finance"
              onSubmit={async (f) => {
                const version = generation.current;
                const response = (await command("credit/exception", {
                  poNumber: po,
                  lines: cart,
                  reason: value(f, "creditReason"),
                })) as unknown as CreditException;
                if (version === generation.current)
                  setCredit({ binding, request: response });
              }}
            >
              <Field label="Why this purchase order needs credit">
                <textarea
                  name="creditReason"
                  required
                  minLength={3}
                  maxLength={300}
                  className={fieldClass}
                />
              </Field>
              <p className="text-sm">
                A different Finance approver must review this exact quotation.
                SAP still decides; the account limit is not raised locally.
              </p>
            </ActionForm>
          )}
          {currentCredit && (
            <>
              <CreditDecision request={currentCredit} />
              <ActionForm
                title="Refresh the credit decision"
                submitLabel="Check Finance and SAP"
                onSubmit={async () => {
                  const version = generation.current;
                  const response = (await command("credit/refresh", {
                    id: currentCredit.id,
                  })) as unknown as CreditException;
                  if (version !== generation.current) return;
                  setCredit({ binding, request: response });
                  if (response.phase === "approved") {
                    const quote = (await command("quote", {
                      poNumber: po,
                      lines: cart,
                      sapCreditExceptionId: response.id,
                    })) as unknown as Quote;
                    if (version === generation.current) {
                      setPreviewOwner(id);
                      setPreview(quote);
                    }
                  }
                }}
              >
                <p className="text-sm">
                  Confirmation is enabled only after the provider approves and
                  stock is still available.
                </p>
              </ActionForm>
            </>
          )}
          <PartnerDiscountApproval
            authority={preview.authority}
            onRequest={async (reason) => {
              await command("quote/approval", { lines: cart, reason });
              setPreview(
                (await command("quote", { lines: cart })) as unknown as Quote,
              );
            }}
            onRefresh={async () =>
              setPreview(
                (await command("quote", { lines: cart })) as unknown as Quote,
              )
            }
          />
          {preview.canConfirm ? (
            <ActionForm
              title="Confirm this purchase order"
              submitLabel="Submit purchase order"
              onSubmit={async () => {
                await command("orders", {
                  poNumber: po,
                  lines: cart,
                  ...(currentCredit?.phase === "approved"
                    ? { sapCreditExceptionId: currentCredit.id }
                    : {}),
                });
                setConfirmed(preview);
                setPreview(null);
              }}
            >
              <p className="text-sm">
                {po} · {money(preview.totalCentavos)}
              </p>
            </ActionForm>
          ) : (
            <Empty>
              Confirmation is blocked. Resolve accreditation, stock, SAP credit
              or Finance discount authority before ordering.
            </Empty>
          )}
        </Panel>
      ) : null}
      {confirmed ? (
        <Panel
          title="Purchase order submitted"
          detail="Your acknowledgement and promised delivery are listed in the order history below."
        >
          <p className="text-lg font-semibold">
            {money(confirmed.totalCentavos)}
          </p>
          {confirmed.benefits.map((b) => (
            <p key={b.name} className="text-sm">
              {b.name} · {money(b.discountCentavos)} discount
            </p>
          ))}
          <p className="text-sm">
            Credit check at confirmation: {words(confirmed.credit.status)} ·{" "}
            {when(confirmed.credit.checkedAt)}
          </p>
        </Panel>
      ) : null}
      <State query={orders}>
        {(o) => (
          <Panel title="Acknowledgements and delivery dates">
            {o.rows.length ? (
              <Table
                headers={[
                  "Order",
                  "Your PO",
                  "Amount",
                  "Stage",
                  "Promised delivery",
                ]}
              >
                {o.rows.map((r) => (
                  <tr key={r.id}>
                    <Cell>{r.order_number}</Cell>
                    <Cell>{r.customer_po_number}</Cell>
                    <Cell>{money(r.total_centavos)}</Cell>
                    <Cell>
                      {words(r.status)}
                      <p className="text-xs text-muted">
                        {r.acknowledged_at
                          ? "Acknowledged"
                          : "Awaiting SAP acknowledgement"}
                      </p>
                    </Cell>
                    <Cell>{when(r.promised_delivery_date)}</Cell>
                  </tr>
                ))}
              </Table>
            ) : (
              <Empty>
                No primary orders yet. Raise your first purchase order above.
              </Empty>
            )}
            {o.next ? (
              <p className="text-sm text-muted">
                More orders exist; use the connector API cursor to continue.
                This is not the complete history.
              </p>
            ) : (
              <a
                className="text-sm underline"
                href={`/api/v1/distributors/orders?distributorId=${id}&format=csv`}
              >
                Export this order history
              </a>
            )}
          </Panel>
        )}
      </State>
    </>
  );
}
export function Stock({
  workspace,
  command,
  canWrite,
}: {
  workspace: Workspace;
  command: Command;
  canWrite: boolean;
}) {
  const query = usePartnerQuery<Health>(
    workspace.distributor.id,
    "stock-health",
  );
  const [batches, setBatches] = useState<Record<string, number>>({});
  return (
    <>
      <State query={query}>
        {(h) => (
          <Panel
            title="Stock health by SKU and location"
            detail={`Current declaration: ${when(h.declaration?.date)}. Near-expiry bands and stock targets are editable by Channel Development.`}
          >
            {h.rows.length ? (
              <Table
                headers={[
                  "Product",
                  "Declared stock",
                  "Days of inventory",
                  "Dated stock",
                  "Next action",
                ]}
              >
                {h.rows.map((r) => (
                  <tr key={r.productId}>
                    <Cell>
                      <details>
                        <summary className="cursor-pointer font-medium">
                          {r.name}
                        </summary>
                        {r.locations.map((l, i) => (
                          <p key={i} className="mt-2 text-xs text-muted">
                            {l.locationName} · batch {l.batch} ·{" "}
                            {l.quantityBase} pieces · expiry {when(l.expiry)}
                          </p>
                        ))}
                      </details>
                    </Cell>
                    <Cell>
                      {r.onHand
                        ? `${r.onHand.cases} cases + ${r.onHand.pieces} pieces`
                        : "Unknown"}
                    </Cell>
                    <Cell>
                      {r.daysOfInventory === null
                        ? "Unknown"
                        : r.daysOfInventory.toFixed(1)}
                      <p className="text-xs text-muted">
                        Target {r.targetDays.min}–{r.targetDays.max}
                      </p>
                    </Cell>
                    <Cell>
                      {r.nearExpiryBase} near expiry · {r.expiredBase} expired
                      pieces
                    </Cell>
                    <Cell>{r.nextAction}</Cell>
                  </tr>
                ))}
              </Table>
            ) : (
              <Empty>
                No complete stock declaration. Declare every SKU at every
                warehouse and van.
              </Empty>
            )}
          </Panel>
        )}
      </State>
      {canWrite ? (
        <ActionForm
          title="Daily stock declaration"
          submitLabel="Submit complete declaration"
          detail="Enter total physical pieces for each batch. Existing days need the next revision; the earlier declaration is retained."
          onSubmit={async (f) => {
            const rows = workspace.locations.flatMap((l) =>
              workspace.catalog.flatMap((p) =>
                Array.from(
                  { length: batches[`${l.id}:${p.productId}`] ?? 1 },
                  (_, i) => ({
                    productId: p.productId,
                    locationId: l.id,
                    batch: value(f, `batch:${l.id}:${p.productId}:${i}`),
                    quantityBase: number(f, `qty:${l.id}:${p.productId}:${i}`),
                    expiry:
                      value(f, `expiry:${l.id}:${p.productId}:${i}`) || null,
                  }),
                ),
              ),
            );
            await command("stock", {
              stockDate: value(f, "date"),
              revision: number(f, "revision"),
              source: "portal",
              lines: rows,
            });
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Stock date">
              <input
                type="date"
                name="date"
                defaultValue={manilaToday()}
                required
                className={fieldClass}
              />
            </Field>
            <Field label="Revision">
              <input
                type="number"
                min="1"
                name="revision"
                defaultValue={
                  query.data?.declaration?.date === manilaToday()
                    ? query.data.declaration.revision + 1
                    : 1
                }
                required
                className={fieldClass}
              />
            </Field>
          </div>
          {workspace.locations.map((l) => (
            <fieldset
              key={l.id}
              className="grid gap-3 rounded-lg border border-border p-4"
            >
              <legend className="px-2 text-sm font-medium">
                {l.name} · {words(l.kind)}
              </legend>
              {workspace.catalog.map((p) => (
                <div
                  key={p.productId}
                  className="grid gap-3 border-b border-border pb-4"
                >
                  <p className="text-sm font-medium">{p.name}</p>
                  {Array.from(
                    { length: batches[`${l.id}:${p.productId}`] ?? 1 },
                    (_, i) => (
                      <div key={i} className="grid gap-3 sm:grid-cols-3">
                        <Field label={`Batch ${i + 1}`}>
                          <input
                            required
                            name={`batch:${l.id}:${p.productId}:${i}`}
                            className={fieldClass}
                          />
                        </Field>
                        <Field label="Pieces">
                          <input
                            required
                            type="number"
                            min="0"
                            step="1"
                            name={`qty:${l.id}:${p.productId}:${i}`}
                            className={fieldClass}
                          />
                        </Field>
                        <Field label="Expiry">
                          <input
                            type="date"
                            name={`expiry:${l.id}:${p.productId}:${i}`}
                            className={fieldClass}
                          />
                        </Field>
                      </div>
                    ),
                  )}
                  <button
                    type="button"
                    className="text-left text-xs underline"
                    onClick={() =>
                      setBatches({
                        ...batches,
                        [`${l.id}:${p.productId}`]:
                          (batches[`${l.id}:${p.productId}`] ?? 1) + 1,
                      })
                    }
                  >
                    Add another batch of {p.name}
                  </button>
                </div>
              ))}
            </fieldset>
          ))}
        </ActionForm>
      ) : null}
    </>
  );
}
