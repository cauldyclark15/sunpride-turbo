"use client";

import { Button } from "@heroui/react";
import { api } from "@sunpride/backend/api";
import {
  DataTable,
  EmptyPanel,
  StatusPill,
  type DataColumn,
} from "@sunpride/ui";
import { useConvex, useQuery } from "convex/react";
import { useState } from "react";
import { hashText, parseCsv, type CsvParseError } from "@/lib/csv";
import {
  IMPORT_TEMPLATES,
  chunkKeyFor,
  chunkRows,
  type ImportKind,
} from "@/lib/import-templates";

type RowError = {
  rowNumber: number;
  column?: string;
  code: string;
  message: string;
};

type ImportRow = { rowNumber: number; values: Record<string, string> };

type FileState = {
  fileName: string;
  fileHash: string;
  runKey: string;
  rows: ImportRow[];
  parseErrors: CsvParseError[];
  summary: string | null;
  blocking: boolean;
  progress: string | null;
  outcome: string | null;
  error: string | null;
};

function emptyFileState(): FileState {
  return {
    fileName: "",
    fileHash: "",
    runKey: "",
    rows: [],
    parseErrors: [],
    summary: null,
    blocking: false,
    progress: null,
    outcome: null,
    error: null,
  };
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

/** Base units are scale 1,000 per displayed case. */
function displayBase(value: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  const formatted = (parsed / 1000).toLocaleString("en-PH", {
    maximumFractionDigits: 3,
  });
  return formatted;
}

function ErrorTable({
  errors,
  title,
}: {
  errors: (RowError | CsvParseError)[];
  title: string;
}) {
  return (
    <div className="rounded-lg border border-danger-soft bg-danger-soft/40 p-4">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <ul className="mt-3 grid gap-2 text-xs text-foreground">
        {errors.slice(0, 100).map((error, position) => (
          <li key={`${error.rowNumber}-${position}`} className="flex gap-2">
            <span className="shrink-0 font-semibold tabular-nums">
              Row {"rowNumber" in error ? error.rowNumber : "—"}
            </span>
            <span className="text-muted">
              {"column" in error && error.column ? `${error.column}: ` : ""}
              {error.message}
            </span>
          </li>
        ))}
      </ul>
      {errors.length > 100 ? (
        <p className="mt-2 text-xs text-muted">
          Showing the first 100 of {errors.length} issues.
        </p>
      ) : null}
    </div>
  );
}

function ImportSection({
  kind,
  state,
  setState,
}: {
  kind: ImportKind;
  state: FileState;
  setState: (next: FileState) => void;
}) {
  const config = IMPORT_TEMPLATES[kind];
  const convex = useConvex();
  const [busy, setBusy] = useState(false);

  async function selectFile(file: File) {
    const text = await file.text();
    const parsed = parseCsv(text, config.headers);
    const fileHash = hashText(text);
    setState({
      ...emptyFileState(),
      fileName: file.name,
      fileHash,
      // Content-derived run key: re-uploading the identical file resolves to the same run and
      // is reported as a duplicate instead of posting a second movement. Change the file and
      // it becomes a new run.
      runKey: fileHash,
      rows: parsed.rows,
      parseErrors: parsed.errors,
      outcome: null,
    });
  }

  async function preview() {
    setBusy(true);
    try {
      if (kind === "products") {
        const result = await convex.query(
          api.imports.products.validateProducts,
          {
            rows: state.rows,
          },
        );
        setState({
          ...state,
          summary: `${result.wouldCreate} to create · ${result.wouldUpdate} to update · ${result.errorCount} rejected`,
          blocking: false,
          parseErrors: result.errors,
          error: null,
        });
      } else {
        const result = await convex.query(
          api.imports.openingStock.validateOpeningStock,
          { rows: state.rows },
        );
        setState({
          ...state,
          summary:
            result.errorCount === 0
              ? `${result.accepted} rows accepted · ${displayBase(result.totalQuantityBase)} base units`
              : `Rejected: ${result.errorCount} issue(s) must be fixed before posting`,
          blocking: result.errorCount > 0,
          parseErrors: result.errors,
          error: null,
        });
      }
    } catch (error) {
      setState({ ...state, error: operationErrorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    setBusy(true);
    const chunks = chunkRows(state.rows);
    let created = 0;
    let updated = 0;
    let skipped = 0;
    let accepted = 0;
    let failed = 0;
    let duplicated = false;
    try {
      for (const [index, chunk] of chunks.entries()) {
        setState({
          ...state,
          progress: `Committing chunk ${index + 1} of ${chunks.length}…`,
        });
        const base = {
          runKey: state.runKey,
          chunkIndex: index,
          idempotencyKey: chunkKeyFor(kind, state.runKey, index),
          fileHash: state.fileHash,
          rows: chunk,
        };
        if (kind === "products") {
          const result = await convex.mutation(
            api.imports.products.commitProducts,
            base,
          );
          if (result.duplicate) duplicated = true;
          created += result.created;
          updated += result.updated;
          skipped += result.skipped;
          failed += result.failed;
        } else {
          const sourceReference = chunk[0]?.values.source_reference ?? "";
          const result = await convex.mutation(
            api.imports.openingStock.commitOpeningStock,
            { ...base, sourceReference },
          );
          if (result.duplicate) duplicated = true;
          accepted += result.accepted;
          failed += result.failed;
        }
      }
      setState({
        ...state,
        progress: null,
        outcome: duplicated
          ? "This file was already imported under this run — nothing was written."
          : kind === "products"
            ? `Imported: ${created} created · ${updated} updated · ${skipped} unchanged · ${failed} rejected`
            : `Posted ${accepted} row(s) as ${chunks.length} movement(s)${failed > 0 ? ` · ${failed} rejected` : ""}`,
        error: null,
      });
    } catch (error) {
      setState({
        ...state,
        progress: null,
        error: operationErrorMessage(error),
      });
    } finally {
      setBusy(false);
    }
  }

  const hasHeaderProblem = state.parseErrors.some(
    (error) => error.rowNumber === 1,
  );
  const canCommit =
    !busy &&
    state.rows.length > 0 &&
    !hasHeaderProblem &&
    !(config.allOrNothing && state.blocking) &&
    Boolean(state.runKey);

  return (
    <section className="grid gap-5 rounded-xl border border-border bg-surface p-5 shadow-sm">
      <div className="border-l-4 border-accent pl-3">
        <h2 className="font-semibold text-foreground">{config.label}</h2>
        <p className="mt-1 text-sm text-muted">{config.description}</p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <a
          className="text-sm font-medium text-foreground underline decoration-border underline-offset-4"
          href={config.templatePath}
          download={config.templateFileName}
        >
          Download template
        </a>
        <input
          accept=".csv,text/csv"
          className="text-sm text-foreground file:mr-3 file:rounded-md file:border-0 file:bg-default file:px-3 file:py-2 file:text-sm file:font-medium file:text-default-foreground"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void selectFile(file);
          }}
          type="file"
        />
      </div>

      {state.fileName ? (
        <p className="text-xs text-muted">
          {state.fileName} · {state.rows.length} data row(s) · run{" "}
          <span className="font-medium text-foreground">
            {state.runKey.slice(0, 8)}
          </span>
        </p>
      ) : null}

      {hasHeaderProblem ? (
        <ErrorTable
          errors={state.parseErrors}
          title="The file header is wrong"
        />
      ) : null}

      {!hasHeaderProblem && state.parseErrors.length > 0 ? (
        <ErrorTable
          errors={state.parseErrors}
          title="Row problems found while reading the file"
        />
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          isDisabled={busy || state.rows.length === 0 || hasHeaderProblem}
          onPress={() => void preview()}
          variant="tertiary"
        >
          Preview
        </Button>
        <Button
          isDisabled={!canCommit}
          onPress={() => void commit()}
          variant="primary"
        >
          Commit
        </Button>
        {state.progress ? (
          <span className="text-sm text-muted">{state.progress}</span>
        ) : null}
      </div>

      {state.summary ? (
        <p className="text-sm text-foreground">{state.summary}</p>
      ) : null}
      {state.outcome ? (
        <p className="rounded-md bg-success-soft px-3 py-2 text-sm text-foreground">
          {state.outcome}
        </p>
      ) : null}
      {state.error ? (
        <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-foreground">
          {state.error}
        </p>
      ) : null}
    </section>
  );
}

type RunRow = {
  id: string;
  runKey: string;
  importType: ImportKind;
  status: string;
  chunkCount: number;
  rowCount: number;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  failedCount: number;
  movementIds: string[];
  createdAt: number;
};

function RunHistory() {
  const runs = useQuery(api.imports.runs.list, {});
  const [selected, setSelected] = useState<{
    runKey: string;
    importType: ImportKind;
  } | null>(null);
  const detail = useQuery(
    api.imports.runs.detail,
    selected
      ? { runKey: selected.runKey, importType: selected.importType }
      : "skip",
  );

  const rows: RunRow[] = (runs ?? []).map((run) => ({
    id: `${run.importType}:${run.runKey}`,
    runKey: run.runKey,
    importType: run.importType,
    status: run.status,
    chunkCount: run.chunkCount,
    rowCount: run.rowCount,
    createdCount: run.createdCount,
    updatedCount: run.updatedCount,
    skippedCount: run.skippedCount,
    failedCount: run.failedCount,
    movementIds: run.movementIds,
    createdAt: run.createdAt,
  }));

  const columns: DataColumn<RunRow>[] = [
    {
      key: "run",
      label: "Run",
      render: (row) => (
        <button
          className="font-medium text-foreground underline decoration-border underline-offset-4"
          onClick={() =>
            setSelected({ runKey: row.runKey, importType: row.importType })
          }
          type="button"
        >
          {row.runKey.slice(0, 8)}
        </button>
      ),
    },
    {
      key: "type",
      label: "Type",
      render: (row) => IMPORT_TEMPLATES[row.importType].label,
    },
    {
      key: "status",
      label: "Status",
      render: (row) => (
        <StatusPill tone={row.status === "completed" ? "success" : "danger"}>
          {row.status}
        </StatusPill>
      ),
    },
    {
      key: "rows",
      label: "Rows",
      align: "right",
      render: (row) => String(row.rowCount),
    },
    {
      key: "written",
      label: "Created / updated",
      align: "right",
      render: (row) => `${row.createdCount} / ${row.updatedCount}`,
    },
    {
      key: "rejected",
      label: "Rejected",
      align: "right",
      render: (row) => String(row.failedCount),
    },
    {
      key: "movements",
      label: "Movements",
      align: "right",
      render: (row) => String(row.movementIds.length),
    },
    {
      key: "when",
      label: "When",
      render: (row) =>
        new Intl.DateTimeFormat("en-PH", {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(row.createdAt),
    },
  ];

  return (
    <div className="grid gap-5">
      <DataTable
        columns={columns}
        empty={
          <EmptyPanel
            description="Upload a product master or an opening-stock file to see its counts, actor, and movement here."
            title="No imports yet"
          />
        }
        rows={rows}
      />
      {selected && detail ? (
        <section className="grid gap-4 rounded-xl border border-border bg-surface p-5 shadow-sm">
          <h2 className="font-semibold text-foreground">
            {IMPORT_TEMPLATES[selected.importType].label} ·{" "}
            {selected.runKey.slice(0, 8)}
          </h2>
          <p className="text-sm text-muted">
            {detail.runs.length} chunk(s) · {detail.movements.length}{" "}
            movement(s) recorded
          </p>
          {detail.errors.length > 0 ? (
            <ErrorTable
              errors={detail.errors.map((error) => ({
                rowNumber: error.rowNumber,
                column: error.column,
                code: error.code,
                message: error.message,
              }))}
              title="Recorded row errors"
            />
          ) : (
            <p className="text-sm text-foreground">
              No row errors were recorded for this run.
            </p>
          )}
        </section>
      ) : null}
    </div>
  );
}

export function ImportsWorkspace({ setupMessage }: { setupMessage: string }) {
  const [tab, setTab] = useState<ImportKind | "history">("products");
  const [files, setFiles] = useState<Record<ImportKind, FileState>>({
    products: emptyFileState(),
    opening_stock: emptyFileState(),
  });

  const tabs: { key: ImportKind | "history"; label: string }[] = [
    { key: "products", label: IMPORT_TEMPLATES.products.label },
    { key: "opening_stock", label: IMPORT_TEMPLATES.opening_stock.label },
    { key: "history", label: "Run history" },
  ];

  return (
    <div className="grid gap-6">
      <p className="text-xs font-medium text-muted">{setupMessage}</p>
      <div className="flex flex-wrap gap-2">
        {tabs.map((item) => (
          <Button
            key={item.key}
            onPress={() => setTab(item.key)}
            size="sm"
            variant={tab === item.key ? "primary" : "tertiary"}
          >
            {item.label}
          </Button>
        ))}
      </div>
      {tab === "history" ? (
        <RunHistory />
      ) : (
        <ImportSection
          kind={tab}
          setState={(next) =>
            setFiles((current) => ({ ...current, [tab]: next }))
          }
          state={files[tab]}
        />
      )}
    </div>
  );
}
