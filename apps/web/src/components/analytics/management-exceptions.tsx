"use client";

import { api } from "@sunpride/backend/api";
import type { Id } from "@sunpride/backend/data-model";
import {
  Card,
  DataTable,
  FormField,
  StatusPill,
  WorkspaceIcon,
  type DataColumn,
} from "@sunpride/ui";
import { useQueries, useQuery, type RequestForQueries } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useState, type ReactNode } from "react";
import { formatCentavos, pctLabel } from "../../lib/execution-dashboard";
import {
  BEHIND_PLAN_PCT,
  DIFFERENCE_LABELS,
  emptyFieldTotals,
  hoursSince,
  mergeFieldTotals,
  MIN_PLANNED_FOR_BEHIND,
  monthStart,
  OOS_OUTLET_MIN,
  OOS_PRODUCT_MIN_OUTLETS,
  periodProblem,
  REASON_LABELS,
  REPEAT_GEOFENCE_MIN,
  SAP_KIND_LABELS,
  shortDate,
  shortDateTime,
  TRIP_STATUS_LABELS,
} from "../../lib/management-exceptions";
import { PanelErrorBoundary } from "../panel-error-boundary";
import { manilaToday } from "../supervision/supervision-model";

type FieldPage = FunctionReturnType<typeof api.analytics.exceptions.field>;
type FieldRow = FieldPage["rows"][number];
type Geofence = FunctionReturnType<typeof api.analytics.exceptions.geofence>;
type Operations = FunctionReturnType<
  typeof api.analytics.exceptions.operations
>;
type OutOfStock = FunctionReturnType<
  typeof api.analytics.exceptions.outOfStock
>;

type PeriodFilters = {
  from: string;
  to: string;
  orgUnitId?: Id<"orgUnits">;
};
type PeopleFilters = PeriodFilters & { channel?: string; directOnly?: boolean };

const muted = "text-[13px] text-muted";

function Muted({ children }: { children: ReactNode }) {
  return <p className={muted}>{children}</p>;
}

function Person({ name, detail }: { name: string; detail: (string | null)[] }) {
  return (
    <span className="flex flex-col">
      <span className="text-sm font-medium text-foreground">{name}</span>
      <span className="font-mono text-xs text-muted">
        {detail.filter(Boolean).join(" · ")}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------------------
// Field people: missed high-value outlets and behind plan.

export function FieldExceptionsView({
  rows,
  totals,
  peopleInScope,
  loading,
  truncated,
}: {
  rows: readonly FieldRow[];
  totals: ReturnType<typeof emptyFieldTotals>;
  peopleInScope: number;
  loading: boolean;
  truncated: boolean;
}) {
  const missed = rows.flatMap((row) =>
    row.missedHighValue.map((stop) => ({
      ...stop,
      id: stop.plannedVisitId as string,
      personName: row.name,
      channel: row.channel,
    })),
  );
  const behind = rows
    .filter((row) => row.reasons.length > 0)
    .map((row) => ({ ...row, id: row.profileId as string }));

  const missedColumns: DataColumn<(typeof missed)[number]>[] = [
    {
      key: "outlet",
      label: "Outlet",
      render: (row) => (
        <Person
          name={row.outletName}
          detail={[row.outletCode, row.classification]}
        />
      ),
    },
    {
      key: "person",
      label: "Planned for",
      render: (row) => <Person name={row.personName} detail={[row.channel]} />,
    },
    {
      key: "date",
      label: "Day missed",
      align: "right",
      render: (row) => shortDate(row.serviceDate),
    },
  ];

  const behindColumns: DataColumn<(typeof behind)[number]>[] = [
    {
      key: "person",
      label: "Person",
      render: (row) => (
        <Person name={row.name} detail={[row.employeeCode, row.channel]} />
      ),
    },
    {
      key: "plan",
      label: "Plan done",
      align: "right",
      render: (row) =>
        row.planPct === null
          ? "—"
          : `${row.doneClosed}/${row.plannedClosed} · ${pctLabel(row.planPct)}`,
    },
    {
      key: "sales",
      label: "Sales to date",
      align: "right",
      render: (row) => (
        <span className="flex flex-col items-end">
          <span className="tabular-nums">{formatCentavos(row.sales)}</span>
          <span className="text-xs text-muted">
            {row.salesTarget === null
              ? "No target"
              : `${pctLabel(row.salesPct)} of ${formatCentavos(row.salesTarget)}`}
          </span>
        </span>
      ),
    },
    {
      key: "why",
      label: "Why",
      render: (row) => (
        <span className="flex flex-wrap gap-1">
          {row.reasons.map((reason) => (
            <StatusPill key={reason} tone="warning">
              {REASON_LABELS[reason]}
            </StatusPill>
          ))}
        </span>
      ),
    },
  ];

  return (
    <>
      {loading ? (
        <Muted>
          Checking {totals.people} of {peopleInScope} people…
        </Muted>
      ) : null}
      {truncated ? (
        <Muted>
          Some figures hit a reading limit. Pick a unit, a channel or a shorter
          period.
        </Muted>
      ) : null}
      <Card
        label="Missed high-value outlets"
        count={totals.missedHighValue}
        icon={<WorkspaceIcon name="field" />}
        flush={missed.length > 0}
      >
        {missed.length ? (
          <>
            <DataTable
              rows={missed}
              columns={missedColumns}
              bare
              empty={null}
            />
            {totals.missedHighValue > missed.length ? (
              <div className="px-4 py-2">
                <Muted>
                  Showing the latest {missed.length} of {totals.missedHighValue}
                  .
                </Muted>
              </div>
            ) : null}
          </>
        ) : (
          <Muted>No high-value outlet was missed in this period.</Muted>
        )}
      </Card>
      <Card
        label="Behind plan"
        count={totals.behind}
        icon={<WorkspaceIcon name="user" />}
        flush={behind.length > 0}
      >
        {behind.length ? (
          <DataTable rows={behind} columns={behindColumns} bare empty={null} />
        ) : (
          <Muted>
            Nobody is materially behind plan out of {totals.people} people.
          </Muted>
        )}
      </Card>
      <Muted>
        High value = outlets classed A or key account. Behind plan = under{" "}
        {BEHIND_PLAN_PCT}% of planned stops done (with at least{" "}
        {MIN_PLANNED_FOR_BEHIND}) or of the sales target, counting only days
        that have closed at 10 PM. These rules are provisional until Sunpride
        confirms them.
      </Muted>
    </>
  );
}

function FieldExceptionsData({ filters }: { filters: PeopleFilters }) {
  const first = useQuery(api.analytics.exceptions.field, {
    ...filters,
    page: 0,
  });
  const pageCount = first?.pageCount ?? 1;
  const requests: RequestForQueries = {};
  for (let page = 1; page < pageCount; page++)
    requests[String(page)] = {
      query: api.analytics.exceptions.field,
      args: { ...filters, page },
    };
  const more = useQueries(requests) as Record<
    string,
    FieldPage | Error | undefined
  >;
  if (first === undefined) return <Muted>Checking field people…</Muted>;
  const pages: FieldPage[] = [first];
  let loading = false;
  for (let page = 1; page < pageCount; page++) {
    const result = more[String(page)];
    if (result instanceof Error) throw result;
    if (result === undefined) loading = true;
    else pages.push(result);
  }
  return (
    <FieldExceptionsView
      rows={pages.flatMap((page) => page.rows)}
      totals={pages.reduce(
        (sum, page) => mergeFieldTotals(sum, page.totals),
        emptyFieldTotals(),
      )}
      peopleInScope={first.peopleInScope}
      loading={loading}
      truncated={pages.some((page) => page.truncated)}
    />
  );
}

// ---------------------------------------------------------------------------------------
// Repeated location issues.

export function GeofenceView({ data }: { data: Geofence }) {
  const people = data.people.map((row) => ({
    ...row,
    id: row.profileId as string,
  }));
  const outlets = data.outlets.map((row) => ({
    ...row,
    id: row.outletId as string,
  }));
  const peopleColumns: DataColumn<(typeof people)[number]>[] = [
    {
      key: "person",
      label: "Person",
      render: (row) => <Person name={row.name} detail={[row.channel]} />,
    },
    {
      key: "issues",
      label: "Issues",
      align: "right",
      render: (row) =>
        `${row.issues}${row.open ? ` · ${row.open} to review` : ""}`,
    },
    {
      key: "outlets",
      label: "Outlets",
      align: "right",
      render: (row) => String(row.outlets),
    },
    {
      key: "flags",
      label: "Flags",
      render: (row) =>
        row.mock ? (
          <StatusPill tone="danger">{`Fake location signal ${row.mock}`}</StatusPill>
        ) : (
          <span className="text-muted">—</span>
        ),
    },
    {
      key: "last",
      label: "Last",
      align: "right",
      render: (row) => shortDateTime(row.lastAt),
    },
  ];
  const outletColumns: DataColumn<(typeof outlets)[number]>[] = [
    {
      key: "outlet",
      label: "Outlet",
      render: (row) => (
        <Person name={row.outletName} detail={[row.outletCode]} />
      ),
    },
    {
      key: "issues",
      label: "Issues",
      align: "right",
      render: (row) => String(row.issues),
    },
    {
      key: "people",
      label: "People",
      align: "right",
      render: (row) => String(row.people),
    },
    {
      key: "last",
      label: "Last",
      align: "right",
      render: (row) => shortDateTime(row.lastAt),
    },
  ];
  return (
    <Card
      label="Repeated location issues"
      count={people.length + outlets.length}
      icon={<WorkspaceIcon name="mobile" />}
    >
      <div className="grid gap-3">
        <Muted>
          {data.issues} check-ins or check-outs away from the store or with an
          unreliable location in this period
          {data.open ? `, ${data.open} still to review` : ""}. Listed when a
          person or an outlet has {REPEAT_GEOFENCE_MIN} or more.
        </Muted>
        {data.truncated ? (
          <Muted>Only part of the period was read. Pick a unit.</Muted>
        ) : null}
        {people.length === 0 && outlets.length === 0 ? (
          <Muted>No repeated location issues.</Muted>
        ) : null}
        {people.length ? (
          <DataTable rows={people} columns={peopleColumns} bare empty={null} />
        ) : null}
        {outlets.length ? (
          <>
            <Muted>
              Outlets where several check-ins were away from the pin: the pin
              may be wrong.
            </Muted>
            <DataTable
              rows={outlets}
              columns={outletColumns}
              bare
              empty={null}
            />
          </>
        ) : null}
        <Muted>Review and decide them in Supervision → Exceptions.</Muted>
      </div>
    </Card>
  );
}

function GeofenceData({ filters }: { filters: PeopleFilters }) {
  const data = useQuery(api.analytics.exceptions.geofence, filters);
  if (data === undefined) return <Muted>Checking location issues…</Muted>;
  return <GeofenceView data={data} />;
}

// ---------------------------------------------------------------------------------------
// SAP, trips, stock and cash.

export function OperationsView({
  data,
  now,
}: {
  data: Operations;
  now: number;
}) {
  const { sap, trips, stock } = data;
  const sapCount = sap.available
    ? sap.failed + sap.deadLetter + sap.stuck + sap.connectorsDown.length
    : 0;
  const sapItems = sap.available
    ? sap.items.map((row) => ({ ...row, id: row.eventId }))
    : [];
  const tripItems = trips.available
    ? trips.items.map((row) => ({ ...row, id: row.routeSessionId as string }))
    : [];
  const countItems = stock.available
    ? stock.counts.map((row) => ({ ...row, id: row.sessionId as string }))
    : [];

  const sapColumns: DataColumn<(typeof sapItems)[number]>[] = [
    {
      key: "event",
      label: "Event",
      render: (row) => (
        <Person
          name={row.eventType}
          detail={[row.direction, row.documentRef]}
        />
      ),
    },
    {
      key: "kind",
      label: "State",
      render: (row) => (
        <StatusPill tone={row.kind === "stuck" ? "warning" : "danger"}>
          {SAP_KIND_LABELS[row.kind]}
        </StatusPill>
      ),
    },
    {
      key: "error",
      label: "Last error",
      render: (row) => (
        <span className="text-[13px] text-muted">{row.lastError ?? "—"}</span>
      ),
    },
    {
      key: "when",
      label: "Received",
      align: "right",
      render: (row) => shortDateTime(row.receivedAt),
    },
  ];
  const tripColumns: DataColumn<(typeof tripItems)[number]>[] = [
    {
      key: "route",
      label: "Route",
      render: (row) => <Person name={row.routeCode} detail={[row.truckCode]} />,
    },
    {
      key: "person",
      label: "Salesperson",
      render: (row) => row.salespersonName,
    },
    {
      key: "status",
      label: "Status",
      render: (row) => (
        <StatusPill tone="warning">
          {TRIP_STATUS_LABELS[row.status] ?? row.status}
        </StatusPill>
      ),
    },
    {
      key: "opened",
      label: "Opened",
      align: "right",
      render: (row) => (
        <span className="flex flex-col items-end">
          <span>{shortDateTime(row.openedAt)}</span>
          <span className="text-xs text-muted">
            {`${hoursSince(row.openedAt, now)} h ago`}
          </span>
        </span>
      ),
    },
  ];
  const countColumns: DataColumn<(typeof countItems)[number]>[] = [
    {
      key: "count",
      label: "Count",
      render: (row) => (
        <Person
          name={row.countNumber}
          detail={[row.locationCode, row.countType.replace("_", " ")]}
        />
      ),
    },
    {
      key: "lines",
      label: "Lines off",
      align: "right",
      render: (row) =>
        `${row.varianceLines} · ${row.missingLines} short, ${row.overLines} over`,
    },
    {
      key: "status",
      label: "Status",
      render: (row) => (
        <StatusPill tone={row.open ? "warning" : "neutral"}>
          {row.open ? "Awaiting approval" : "Settled"}
        </StatusPill>
      ),
    },
    {
      key: "when",
      label: "Counted",
      align: "right",
      render: (row) => shortDateTime(row.snapshotAt),
    },
  ];

  return (
    <>
      <Card
        label="SAP failures"
        count={sapCount}
        icon={<WorkspaceIcon name="sap" />}
        flush={sapItems.length > 0}
      >
        {!sap.available ? (
          <Muted>{sap.reason}.</Muted>
        ) : (
          <div className="grid gap-2">
            <div
              className={`flex flex-wrap gap-2 ${sapItems.length ? "px-4 pt-3" : ""}`}
            >
              <StatusPill tone={sap.failed ? "danger" : "neutral"}>
                {`Failed ${sap.failed}`}
              </StatusPill>
              <StatusPill tone={sap.deadLetter ? "danger" : "neutral"}>
                {`Dead letter ${sap.deadLetter}`}
              </StatusPill>
              <StatusPill tone={sap.stuck ? "warning" : "neutral"}>
                {`Stuck over 2 h ${sap.stuck}`}
              </StatusPill>
              {sap.connectorsDown.map((row) => (
                <StatusPill key={row.connectorId} tone="danger">
                  {`Connector ${row.connectorId} down since ${shortDateTime(row.lastSeenAt)}`}
                </StatusPill>
              ))}
            </div>
            {sapItems.length ? (
              <DataTable
                rows={sapItems}
                columns={sapColumns}
                bare
                empty={null}
              />
            ) : (
              <Muted>No SAP failures.</Muted>
            )}
          </div>
        )}
      </Card>
      <Card
        label="Unclosed trips"
        count={tripItems.length}
        icon={<WorkspaceIcon name="inventory" />}
        flush={tripItems.length > 0}
      >
        {!trips.available ? (
          <Muted>{trips.reason}.</Muted>
        ) : tripItems.length ? (
          <DataTable rows={tripItems} columns={tripColumns} bare empty={null} />
        ) : (
          <Muted>Every van trip closed by 10 PM.</Muted>
        )}
      </Card>
      <Card
        label="Stock variances"
        count={
          stock.available ? countItems.length + stock.sapDifferences.open : 0
        }
        icon={<WorkspaceIcon name="inventory" />}
      >
        {!stock.available ? (
          <Muted>{stock.reason}.</Muted>
        ) : (
          <div className="grid gap-3">
            {countItems.length ? (
              <DataTable
                rows={countItems}
                columns={countColumns}
                bare
                empty={null}
              />
            ) : (
              <Muted>No stock count found a difference.</Muted>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] text-foreground">
                {`Open SAP stock differences: ${stock.sapDifferences.open}`}
              </span>
              {stock.sapDifferences.byClassification.map((row) => (
                <StatusPill key={row.classification} tone="neutral">
                  {`${DIFFERENCE_LABELS[row.classification] ?? row.classification} ${row.count}`}
                </StatusPill>
              ))}
            </div>
            {stock.sapDifferences.unmappedHidden ? (
              <Muted>
                Differences without a location are shown on the national view
                only.
              </Muted>
            ) : null}
            {stock.truncated ? (
              <Muted>
                Only part of the stock records was read. Pick a unit.
              </Muted>
            ) : null}
          </div>
        )}
      </Card>
      <Card label="Cash variances" icon={<WorkspaceIcon name="order" />}>
        <Muted>{data.cash.reason}</Muted>
      </Card>
    </>
  );
}

function OperationsData({
  filters,
  now,
}: {
  filters: PeriodFilters;
  now: number;
}) {
  const data = useQuery(api.analytics.exceptions.operations, filters);
  if (data === undefined) return <Muted>Checking operations…</Muted>;
  return <OperationsView data={data} now={now} />;
}

// ---------------------------------------------------------------------------------------
// Out-of-stock hotspots.

export function OutOfStockView({ data }: { data: OutOfStock }) {
  const outlets = data.outlets.map((row) => ({
    ...row,
    id: row.outletId as string,
  }));
  const products = data.products.map((row) => ({
    ...row,
    id: row.productId as string,
  }));
  const outletColumns: DataColumn<(typeof outlets)[number]>[] = [
    {
      key: "outlet",
      label: "Outlet",
      render: (row) => (
        <Person name={row.outletName} detail={[row.outletCode]} />
      ),
    },
    {
      key: "findings",
      label: "Times out of stock",
      align: "right",
      render: (row) => String(row.findings),
    },
    {
      key: "products",
      label: "Products",
      align: "right",
      render: (row) => String(row.products),
    },
    {
      key: "last",
      label: "Last seen",
      align: "right",
      render: (row) => shortDate(row.lastDate),
    },
  ];
  const productColumns: DataColumn<(typeof products)[number]>[] = [
    {
      key: "product",
      label: "Product",
      render: (row) => (
        <Person name={row.productName} detail={[row.productCode]} />
      ),
    },
    {
      key: "outlets",
      label: "Outlets",
      align: "right",
      render: (row) => String(row.outlets),
    },
    {
      key: "findings",
      label: "Times out of stock",
      align: "right",
      render: (row) => String(row.findings),
    },
  ];
  return (
    <Card
      label="Out-of-stock hotspots"
      count={outlets.length + products.length}
      icon={<WorkspaceIcon name="catalog" />}
    >
      <div className="grid gap-3">
        <Muted>
          {data.findings} out-of-stock findings in {data.outletsAffected}{" "}
          outlets. Listed: outlets out of stock {OOS_OUTLET_MIN} or more times,
          products out of stock in {OOS_PRODUCT_MIN_OUTLETS} or more outlets.
        </Muted>
        {data.truncated ? (
          <Muted>Only part of the period was read. Pick a unit.</Muted>
        ) : null}
        {outlets.length === 0 && products.length === 0 ? (
          <Muted>No out-of-stock hotspots.</Muted>
        ) : null}
        {outlets.length ? (
          <DataTable rows={outlets} columns={outletColumns} bare empty={null} />
        ) : null}
        {products.length ? (
          <DataTable
            rows={products}
            columns={productColumns}
            bare
            empty={null}
          />
        ) : null}
        {data.units.length > 1 ? (
          <div className="flex flex-wrap gap-2">
            {data.units.map((unit) => (
              <StatusPill key={unit.orgUnitId} tone="neutral">
                {`${unit.name} ${unit.findings}`}
              </StatusPill>
            ))}
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function OutOfStockData({ filters }: { filters: PeriodFilters }) {
  const data = useQuery(api.analytics.exceptions.outOfStock, filters);
  if (data === undefined) return <Muted>Checking shelf audits…</Muted>;
  return <OutOfStockView data={data} />;
}

// ---------------------------------------------------------------------------------------

/**
 * ANA-007 management exception dashboard: what needs a manager in the selected scope and
 * period. Each list is its own read inside its own error boundary.
 */
export function ManagementExceptions() {
  const [now] = useState(() => Date.now());
  const today = manilaToday(now);
  const [from, setFrom] = useState(() => monthStart(today));
  const [to, setTo] = useState(today);
  const [orgUnitId, setOrgUnitId] = useState<Id<"orgUnits"> | "">("");
  const [channel, setChannel] = useState("");
  const [directOnly, setDirectOnly] = useState(false);
  const options = useQuery(api.supervision.team.options, { serviceDate: to });
  const problem = periodProblem(from, to);
  const period: PeriodFilters = {
    from,
    to,
    ...(orgUnitId ? { orgUnitId } : {}),
  };
  const people: PeopleFilters = {
    ...period,
    ...(channel ? { channel } : {}),
    ...(directOnly ? { directOnly } : {}),
  };
  const key = `${from}-${to}-${orgUnitId}`;
  const peopleKey = `${key}-${channel}-${directOnly}`;
  return (
    <section className="grid gap-4" aria-label="Exceptions to manage">
      <h2 className="text-base font-semibold text-foreground">
        Exceptions to manage
      </h2>
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-[170px] max-w-full">
          <FormField label="From">
            <input
              type="date"
              aria-label="From"
              className="h-10 w-full"
              value={from}
              max={to}
              onChange={(event) => setFrom(event.target.value)}
            />
          </FormField>
        </div>
        <div className="w-[170px] max-w-full">
          <FormField label="To">
            <input
              type="date"
              aria-label="To"
              className="h-10 w-full"
              value={to}
              max={today}
              onChange={(event) => {
                if (event.target.value) setTo(event.target.value);
              }}
            />
          </FormField>
        </div>
        {options && options.units.length > 1 && (
          <div className="w-[220px] max-w-full">
            <FormField label="Unit">
              <select
                aria-label="Unit"
                className="h-10 w-full"
                value={orgUnitId}
                onChange={(event) =>
                  setOrgUnitId(event.target.value as Id<"orgUnits"> | "")
                }
              >
                <option value="">All units</option>
                {options.units.map((unit) => (
                  <option key={unit.id} value={unit.id}>
                    {unit.name}
                  </option>
                ))}
              </select>
            </FormField>
          </div>
        )}
        {options && options.channels.length > 0 && (
          <div className="w-[200px] max-w-full">
            <FormField label="Channel">
              <select
                aria-label="Channel"
                className="h-10 w-full"
                value={channel}
                onChange={(event) => setChannel(event.target.value)}
              >
                <option value="">All channels</option>
                {options.channels.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </FormField>
          </div>
        )}
        <label className="flex h-10 items-center gap-2 text-[13px] text-foreground">
          <input
            type="checkbox"
            checked={directOnly}
            onChange={(event) => setDirectOnly(event.target.checked)}
          />
          My team only
        </label>
      </div>
      {problem ? (
        <Muted>{problem}.</Muted>
      ) : (
        <>
          <Muted>
            Channel and My team only narrow the people lists; unit narrows
            everything.
          </Muted>
          <PanelErrorBoundary key={`field-${peopleKey}`} label="Field people">
            <FieldExceptionsData filters={people} />
          </PanelErrorBoundary>
          <PanelErrorBoundary
            key={`geofence-${peopleKey}`}
            label="Location issues"
          >
            <GeofenceData filters={people} />
          </PanelErrorBoundary>
          <PanelErrorBoundary key={`ops-${key}`} label="Operations">
            <OperationsData filters={period} now={now} />
          </PanelErrorBoundary>
          <PanelErrorBoundary key={`oos-${key}`} label="Out of stock">
            <OutOfStockData filters={period} />
          </PanelErrorBoundary>
        </>
      )}
    </section>
  );
}
