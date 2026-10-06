"use client";

import { Button } from "@heroui/react";
import { api } from "@sunpride/backend/api";
import type { Id } from "@sunpride/backend/data-model";
import { Card, FormField, WorkspaceIcon } from "@sunpride/ui";
import { useQuery } from "convex/react";
import { useState } from "react";
import {
  callStatusText,
  dailySalesCsv,
  dailyTargetNote,
  dateLabel,
  manilaToday,
  percentText,
  pesoText,
  remarksText,
  type DsrReport,
} from "../../lib/daily-sales";
import { isBetaFeatureOn } from "../../config/beta";
import { PanelErrorBoundary } from "../panel-error-boundary";
import "./daily-sales-print.css";

export function DailySalesWorkspace() {
  const [serviceDate, setServiceDate] = useState(() => manilaToday());
  const [chosen, setChosen] = useState<Id<"profiles"> | null>(null);
  const options = useQuery(api.dsr.report.salesmen, { serviceDate });
  const people = options?.people ?? [];
  const profileId =
    options?.self || (chosen === null && people.length === 1)
      ? (people[0]?.profileId ?? null)
      : chosen && people.some((p) => p.profileId === chosen)
        ? chosen
        : null;
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-[180px] max-w-full">
          <FormField label="Date">
            <input
              type="date"
              aria-label="Date"
              className="h-10 w-full"
              value={serviceDate}
              max={manilaToday()}
              onChange={(event) => {
                if (event.target.value) setServiceDate(event.target.value);
              }}
            />
          </FormField>
        </div>
        {options && !options.self && people.length > 0 && (
          <div className="w-[280px] max-w-full">
            <FormField label="Salesman">
              <select
                aria-label="Salesman"
                className="h-10 w-full"
                value={profileId ?? ""}
                onChange={(event) =>
                  setChosen(
                    event.target.value
                      ? (event.target.value as Id<"profiles">)
                      : null,
                  )
                }
              >
                <option value="">Choose a salesman…</option>
                {people.map((person) => (
                  <option key={person.profileId} value={person.profileId}>
                    {person.name}
                    {person.position ? ` · ${person.position}` : ""}
                  </option>
                ))}
              </select>
            </FormField>
          </div>
        )}
      </div>
      {options?.truncated && (
        <p role="status" className="text-sm text-muted">
          Showing the first salesmen in your area only.
        </p>
      )}
      {options === undefined ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : profileId ? (
        <PanelErrorBoundary
          key={`${profileId}:${serviceDate}`}
          label="Daily sales report"
        >
          <DailySalesSheet profileId={profileId} serviceDate={serviceDate} />
        </PanelErrorBoundary>
      ) : (
        <Card
          label="Daily sales report"
          icon={<WorkspaceIcon name="reports" />}
        >
          <p className="text-sm text-muted">
            {people.length === 0
              ? "No salesmen in your area. Supervisors and the salesmen themselves can open this report."
              : "Choose a salesman to see their daily sales report."}
          </p>
        </Card>
      )}
    </div>
  );
}

function DailySalesSheet({
  profileId,
  serviceDate,
}: {
  profileId: Id<"profiles">;
  serviceDate: string;
}) {
  const report = useQuery(api.dsr.report.day, { profileId, serviceDate });
  if (report === undefined)
    return <p className="text-sm text-muted">Loading…</p>;
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap gap-3">
        <Button
          variant="outline"
          className="h-10"
          onPress={() => download(report)}
        >
          Export CSV
        </Button>
        <Button
          variant="outline"
          className="h-10"
          onPress={() => window.print()}
        >
          Print / Save PDF
        </Button>
      </div>
      <DailySalesView report={report} />
    </div>
  );
}

function download(report: DsrReport) {
  const blob = new Blob([dailySalesCsv(report)], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `dsr-${report.salesman.name.replace(/[^A-Za-z0-9]+/g, "-")}-${report.serviceDate}.csv`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Figure({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="grid gap-0.5 rounded-xl border border-border p-3">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted">
        {label}
      </span>
      <span className="text-base font-semibold tabular-nums">{value}</span>
      {note && <span className="text-[12px] text-muted">{note}</span>}
    </div>
  );
}

/** The Annex B sheet itself; also the print view. */
export function DailySalesView({ report }: { report: DsrReport }) {
  const { totals, targets, calls } = report;
  const showNewProducts = isBetaFeatureOn("dsr-new-products");
  return (
    <section
      className="daily-sales-print-view grid gap-4"
      aria-label="Daily sales report"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">
          Daily Sales Report · {report.salesman.name}
        </h2>
        <p className="text-[13px] text-muted">
          {dateLabel(report.serviceDate)}
        </p>
      </div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        {(
          [
            ["SI number", report.invoiceNumbers.join(", ") || "—"],
            [
              "Salesman",
              [report.salesman.name, report.salesman.position]
                .filter(Boolean)
                .join(" · "),
            ],
            ["Area covered", report.areaCovered.join(", ") || "—"],
            ["Date", report.serviceDate],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="flex gap-2">
            <dt className="min-w-32 text-muted">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Figure
          label="Today's sale"
          value={pesoText(totals.todaySales)}
          note={`Target ${pesoText(targets.daily)} · ${percentText(totals.todayPct)} · ${dailyTargetNote(report)}`}
        />
        <Figure
          label="MTD performance"
          value={pesoText(totals.mtdSales)}
          note={`Target ${pesoText(targets.monthly)} · ${percentText(totals.mtdPct)}`}
        />
        <Figure
          label="MTD balance to sell"
          value={pesoText(totals.balanceToSell)}
          note={targets.monthly === null ? "No monthly target set" : undefined}
        />
        <Figure
          label="Productive calls"
          value={`${calls.productiveCalls} of ${calls.calls}`}
          note={`${percentText(calls.productivePct)} · ${calls.planned} planned${
            calls.dailyCallsTarget !== null
              ? ` · standard ${calls.dailyCallsTarget} calls, ${percentText(calls.productiveCallTargetPct)} productive`
              : ""
          }`}
        />
      </div>

      <div className="grid gap-2">
        <h3 className="text-sm font-semibold">Actual coverage</h3>
        {report.customers.length === 0 ? (
          <p className="text-sm text-muted">
            No route-plan stores, visits or sales on this day.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="min-w-full text-[13px] tabular-nums">
              <thead className="text-left text-muted">
                <tr>
                  <th className="px-2 py-1 font-normal">Customer</th>
                  <th className="px-2 py-1 font-normal">Call</th>
                  <th className="px-2 py-1 text-right font-normal">
                    Today&apos;s sale
                  </th>
                  <th className="px-2 py-1 text-right font-normal">MTD sale</th>
                  <th className="px-2 py-1 font-normal">SI</th>
                  <th className="px-2 py-1 font-normal">Remarks</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-separator">
                {report.customers.map((row) => (
                  <tr key={row.key}>
                    <td className="px-2 py-1">
                      <span className="font-medium">{row.name}</span>
                      <span className="block text-[12px] text-muted">
                        {[row.outletCode, row.customerCode]
                          .filter(Boolean)
                          .join(" · ")}
                        {row.inRoutePlan ? "" : " · not in route plan"}
                      </span>
                    </td>
                    <td className="px-2 py-1">
                      {callStatusText(row.callStatus)}
                    </td>
                    <td className="px-2 py-1 text-right">
                      {pesoText(row.todaySales)}
                    </td>
                    <td className="px-2 py-1 text-right">
                      {pesoText(row.mtdSales)}
                    </td>
                    <td className="px-2 py-1">
                      {row.invoiceNumbers.join(", ")}
                    </td>
                    <td className="px-2 py-1">{remarksText(row)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-border font-medium">
                  <td className="px-2 py-1" colSpan={2}>
                    Total (all customers)
                  </td>
                  <td className="px-2 py-1 text-right">
                    {pesoText(totals.todaySales)}
                  </td>
                  <td className="px-2 py-1 text-right">
                    {pesoText(totals.mtdSales)}
                  </td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      <div
        className={`grid gap-4 ${showNewProducts ? "lg:grid-cols-3" : "lg:grid-cols-2"}`}
      >
        <div className="grid content-start gap-2">
          <h3 className="text-sm font-semibold">Categories</h3>
          <table className="min-w-full text-[13px] tabular-nums">
            <thead className="text-left text-muted">
              <tr>
                <th className="px-2 py-1 font-normal">Category</th>
                <th className="px-2 py-1 text-right font-normal">Today</th>
                <th className="px-2 py-1 text-right font-normal">MTD</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-separator">
              {report.categories.map((row) => (
                <tr key={row.category}>
                  <td className="px-2 py-1">{row.category}</td>
                  <td className="px-2 py-1 text-right">
                    {pesoText(row.todaySales)}
                    <span className="block text-[12px] text-muted">
                      {row.todayQuantity} qty
                    </span>
                  </td>
                  <td className="px-2 py-1 text-right">
                    {pesoText(row.mtdSales)}
                    <span className="block text-[12px] text-muted">
                      {row.mtdQuantity} qty
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {/* Beta: an empty placeholder until Sunpride's list arrives (config/beta.ts). */}
        {showNewProducts ? (
          <div className="grid content-start gap-2">
            <h3 className="text-sm font-semibold">New products</h3>
            <p className="text-sm text-muted">
              Waiting for Sunpride&apos;s list of new products and the original
              report template.
            </p>
          </div>
        ) : null}
        <div className="grid content-start gap-2">
          <h3 className="text-sm font-semibold">Programs</h3>
          {report.programs.length === 0 ? (
            <p className="text-sm text-muted">No programs checked today.</p>
          ) : (
            <table className="min-w-full text-[13px] tabular-nums">
              <thead className="text-left text-muted">
                <tr>
                  <th className="px-2 py-1 font-normal">Program</th>
                  <th className="px-2 py-1 text-right font-normal">Done</th>
                  <th className="px-2 py-1 text-right font-normal">Not done</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-separator">
                {report.programs.map((row) => (
                  <tr key={row.programRef}>
                    <td className="px-2 py-1">{row.programRef}</td>
                    <td className="px-2 py-1 text-right">{row.executed}</td>
                    <td className="px-2 py-1 text-right">{row.notExecuted}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="daily-sales-signatures grid gap-6 pt-6 text-sm sm:grid-cols-2">
        {["Salesman signature / date", "CDM / COM signature / date"].map(
          (label) => (
            <div key={label} className="border-t border-border pt-1 text-muted">
              {label}
            </div>
          ),
        )}
      </div>
    </section>
  );
}
