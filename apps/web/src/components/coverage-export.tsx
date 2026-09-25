"use client";
import { api } from "@sunpride/backend/api";
import type { Id } from "@sunpride/backend/data-model";
import { useConvex } from "convex/react";
import { useState } from "react";
import {
  collectSchedule,
  EXPORT_PAGE_SIZE,
  scheduleCsv,
  type ScheduleFilters,
  type ScheduleHeader,
  type ScheduleRow,
} from "../lib/coverage-export";
import { CoveragePrint } from "./coverage-print";

export function CoverageExport({ planId }: { planId: Id<"coveragePlans"> }) {
  const convex = useConvex();
  const [territoryId, setTerritory] = useState("");
  const [routeId, setRoute] = useState("");
  const [visitStatus, setStatus] = useState<
    "" | "planned" | "cancelled" | "replaced"
  >("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [printData, setPrintData] = useState<{
    header: ScheduleHeader;
    rows: ScheduleRow[];
    filters: ScheduleFilters;
  }>();
  function filters(): ScheduleFilters {
    return {
      territoryId: territoryId || undefined,
      routeId: routeId || undefined,
      visitStatus: visitStatus || undefined,
    };
  }
  async function prepare(mode: "csv" | "print") {
    setBusy(true);
    setError("");
    setPrintData(undefined);
    const selected = filters();
    try {
      const { header, rows } = await collectSchedule((cursor) =>
        convex.query(api.coverage.exports.schedule, {
          planId,
          territoryId: selected.territoryId as Id<"territories"> | undefined,
          routeId: selected.routeId as Id<"routes"> | undefined,
          visitStatus: selected.visitStatus,
          paginationOpts: { cursor, numItems: EXPORT_PAGE_SIZE },
        }),
      );
      if (mode === "print") setPrintData({ header, rows, filters: selected });
      else {
        const blob = new Blob([scheduleCsv(header, rows, selected)], {
          type: "text/csv;charset=utf-8",
        });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `coverage-${header.localMonth}-v${header.version}.csv`;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Export failed; no file was created",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      aria-label="Coverage export"
      className="space-y-3 rounded border border-border p-4"
    >
      <h3>Scoped schedule export</h3>
      <p>CSV opens in a spreadsheet. Print → Save as PDF uses your browser.</p>
      <div className="flex flex-wrap gap-2">
        <label>
          Territory ID{" "}
          <input
            aria-label="Export territory ID"
            value={territoryId}
            onChange={(e) => {
              setTerritory(e.target.value);
              setPrintData(undefined);
            }}
          />
        </label>
        <label>
          Route ID{" "}
          <input
            aria-label="Export route ID"
            value={routeId}
            onChange={(e) => {
              setRoute(e.target.value);
              setPrintData(undefined);
            }}
          />
        </label>
        <label>
          Visit status{" "}
          <select
            aria-label="Export visit status"
            value={visitStatus}
            onChange={(e) => {
              setStatus(e.target.value as typeof visitStatus);
              setPrintData(undefined);
            }}
          >
            <option value="">All</option>
            <option value="planned">Planned</option>
            <option value="cancelled">Cancelled</option>
            <option value="replaced">Replaced</option>
          </select>
        </label>
      </div>
      <button type="button" disabled={busy} onClick={() => void prepare("csv")}>
        Export CSV
      </button>
      {" · "}
      <button
        type="button"
        disabled={busy}
        onClick={() => void prepare("print")}
      >
        Prepare print view
      </button>
      {busy && <p>Loading all scoped pages…</p>}
      {error && <p role="alert">{error}</p>}
      {printData && <CoveragePrint {...printData} />}
    </section>
  );
}
