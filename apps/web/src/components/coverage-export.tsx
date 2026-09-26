"use client";
import { Button } from "@heroui/react";
import { Card, WorkspaceIcon } from "@sunpride/ui";
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
import {
  CoverageScopeSelect,
  useCoverageScopeOptions,
} from "./coverage-scope-filters";

export function CoverageExport({ planId }: { planId: Id<"coveragePlans"> }) {
  const convex = useConvex();
  const options = useCoverageScopeOptions(planId);
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
    const territory = options?.territories.find(
      (option) => option.id === territoryId,
    );
    const route = options?.routes.find((option) => option.id === routeId);
    return {
      territoryId: territoryId || undefined,
      routeId: routeId || undefined,
      visitStatus: visitStatus || undefined,
      territoryLabel: territory
        ? `${territory.code} · ${territory.name}`
        : undefined,
      routeLabel: route ? `${route.code} · ${route.name}` : undefined,
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
    <Card label="Export" icon={<WorkspaceIcon name="field" />}>
      <div className="grid gap-4">
        <div className="flex flex-wrap gap-3">
          <CoverageScopeSelect
            label="Territory"
            options={options?.territories ?? []}
            selected={territoryId}
            onSelect={(id) => {
              setTerritory(id);
              setPrintData(undefined);
            }}
          />
          <CoverageScopeSelect
            label="Route"
            options={options?.routes ?? []}
            selected={routeId}
            onSelect={(id) => {
              setRoute(id);
              setPrintData(undefined);
            }}
          />
          <label className="grid gap-1.5 text-[13px] font-medium">
            Visit status
            <select
              className="h-10 rounded-[10px] border border-border bg-surface px-3 text-sm"
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
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            className="h-10"
            isDisabled={busy}
            onPress={() => void prepare("csv")}
          >
            Export CSV
          </Button>
          <Button
            variant="outline"
            className="h-10"
            isDisabled={busy}
            onPress={() => void prepare("print")}
          >
            Prepare print
          </Button>
        </div>
        {busy && <p>Loading all scoped pages…</p>}
        {error && <p role="alert">{error}</p>}
        {printData && <CoveragePrint {...printData} />}
      </div>
    </Card>
  );
}
