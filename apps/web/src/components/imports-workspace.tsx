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
import { hashText, parseCsv } from "../lib/csv";
import {
  downloadCsv,
  errorCsv,
  OPERATIONAL_HEADERS,
  type ImportError,
} from "../lib/import-csv-export";
import {
  IMPORT_TEMPLATES,
  chunkRows,
  type ImportKind,
} from "../lib/import-templates";

type WorkspaceKind = ImportKind | "stock_adjustment" | "cycle_count";
const OPERATIONAL_CONFIG = {
  stock_adjustment: {
    label: "Stock adjustment",
    description: "Request a signed stock adjustment for separate approval.",
    headers: OPERATIONAL_HEADERS.stock_adjustment.split(","),
    templateFileName: "stock-adjustment.csv",
    allOrNothing: true,
  },
  cycle_count: {
    label: "Cycle count",
    description:
      "Submit absolute counted quantities from an open count session.",
    headers: OPERATIONAL_HEADERS.cycle_count.split(","),
    templateFileName: "cycle-count.csv",
    allOrNothing: true,
  },
};
const CONFIG = { ...IMPORT_TEMPLATES, ...OPERATIONAL_CONFIG };

function isOperational(
  kind: WorkspaceKind,
): kind is keyof typeof OPERATIONAL_CONFIG {
  return kind === "stock_adjustment" || kind === "cycle_count";
}

type ImportRow = { rowNumber: number; values: Record<string, string> };

type FileState = {
  fileName: string;
  fileHash: string;
  runKey: string;
  header: string[];
  rows: ImportRow[];
  parseErrors: ImportError[];
  previewErrors: ImportError[];
  previewed: boolean;
  partitions: {
    productCode: string;
    baseUomCode: string;
    locationCode: string;
    stockStatus: string;
    lotNumber?: string;
    positiveBase: bigint;
    negativeBase: bigint;
    netDeltaBase: bigint;
    currentBase: bigint;
    projectedBase: bigint;
  }[];
  countedLines: { rowNumber: number; countedBase: bigint; status: string }[];
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
    header: [],
    rows: [],
    parseErrors: [],
    previewErrors: [],
    previewed: false,
    partitions: [],
    countedLines: [],
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
  errors: ImportError[];
  title: string;
}) {
  const columns: DataColumn<ImportError & { id: string }>[] = [
    { key: "row", label: "Row", render: (error) => String(error.rowNumber) },
    { key: "column", label: "Column", render: (error) => error.column ?? "—" },
    { key: "code", label: "Code", render: (error) => error.code },
    { key: "message", label: "Message", render: (error) => error.message },
  ];
  return (
    <div className="rounded-lg border border-danger-soft bg-danger-soft/40 p-4">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <DataTable
        columns={columns}
        empty={null}
        rows={errors.slice(0, 100).map((error, index) => ({
          ...error,
          id: `${error.rowNumber}-${index}`,
        }))}
      />
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
  kind: WorkspaceKind;
  state: FileState;
  setState: (next: FileState) => void;
}) {
  const config = CONFIG[kind];
  const convex = useConvex();
  const [busy, setBusy] = useState(false);

  async function selectFile(file: File) {
    try {
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
        header: parsed.header,
        parseErrors: [
          ...parsed.errors,
          ...(isOperational(kind) &&
          parsed.header.join(",") !== OPERATIONAL_HEADERS[kind]
            ? [
                {
                  rowNumber: 1,
                  code: "invalid_format",
                  column: "header",
                  message:
                    "Header must match the template exactly and in order.",
                },
              ]
            : []),
        ],
        outcome: null,
      });
    } catch (error) {
      setState({ ...emptyFileState(), error: operationErrorMessage(error) });
    }
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
          summary: `${result.wouldCreate + result.wouldUpdate} valid · ${result.errorCount} rejected · ${result.wouldCreate} to create · ${result.wouldUpdate} to update`,
          blocking: false,
          previewed: true,
          previewErrors: result.errors,
          error: null,
        });
      } else if (kind === "opening_stock") {
        const result = await convex.query(
          api.imports.openingStock.validateOpeningStock,
          { rows: state.rows },
        );
        setState({
          ...state,
          summary: `${result.accepted} valid · ${result.errorCount} rejected${result.errorCount ? " · fix errors before posting" : ` · ${displayBase(result.totalQuantityBase)} base units`}`,
          blocking: result.errorCount > 0,
          previewed: true,
          previewErrors: result.errors,
          error: null,
        });
      } else if (kind === "stock_adjustment") {
        const result = await convex.query(api.imports.adjustments.preview, {
          rows: state.rows,
          header: state.header,
        });
        setState({
          ...state,
          previewed: true,
          previewErrors: result.errors,
          blocking: result.errorCount > 0,
          partitions: result.partitions,
          summary: `${result.accepted} valid · ${result.errorCount} rejected · ${result.requestChunks} approval request(s)`,
          error: null,
        });
      } else {
        const groups = new Map<string, ImportRow[]>();
        for (const row of state.rows) {
          const ref = row.values.count_reference ?? "";
          groups.set(ref, [...(groups.get(ref) ?? []), row]);
        }
        const previews = [];
        for (const rows of groups.values())
          previews.push(
            await convex.query(api.imports.counts.preview, {
              rows,
              header: state.header,
            }),
          );
        // Deliberately project only blind-safe fields, even when the server returns approver data.
        const errors = previews.flatMap((result) => result.errors);
        setState({
          ...state,
          previewed: true,
          previewErrors: errors,
          blocking: errors.length > 0,
          countedLines: previews.flatMap((result) =>
            result.lines.map(({ rowNumber, countedBase, status }) => ({
              rowNumber,
              countedBase,
              status,
            })),
          ),
          summary: `${previews.reduce((sum, result) => sum + result.accepted, 0)} valid · ${errors.length} rejected`,
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
    const chunks =
      kind === "cycle_count"
        ? (() => {
            const groups = new Map<string, ImportRow[]>();
            for (const row of state.rows) {
              const ref = row.values.count_reference ?? "";
              groups.set(ref, [...(groups.get(ref) ?? []), row]);
            }
            // The server requires one complete count session per chunk, never split one.
            return [...groups.values()];
          })()
        : chunkRows(state.rows);
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
          idempotencyKey: `${kind}:${state.runKey}:${index}`,
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
        } else if (kind === "opening_stock") {
          const sourceReference = chunk[0]?.values.source_reference ?? "";
          const result = await convex.mutation(
            api.imports.openingStock.commitOpeningStock,
            { ...base, sourceReference },
          );
          if (result.duplicate) duplicated = true;
          accepted += result.accepted;
          failed += result.failed;
        } else {
          const args = {
            ...base,
            rowCount: state.rows.length,
            header: state.header,
          };
          const result =
            kind === "stock_adjustment"
              ? await convex.mutation(api.imports.adjustments.commit, args)
              : await convex.mutation(api.imports.counts.commit, args);
          if (result.duplicate) duplicated = true;
          accepted += result.accepted;
          failed += result.failed;
          if (result.errors.length) {
            setState({
              ...state,
              progress: null,
              blocking: true,
              previewErrors: result.errors,
              error:
                "The server rejected this chunk; review its row errors before submitting again.",
            });
            return;
          }
        }
      }
      setState({
        ...state,
        progress: null,
        outcome: duplicated
          ? "This file was already imported under this run — nothing was written."
          : kind === "products"
            ? `Imported: ${created} created · ${updated} updated · ${skipped} unchanged · ${failed} rejected`
            : kind === "opening_stock"
              ? `Posted ${accepted} row(s) as ${chunks.length} movement(s)${failed > 0 ? ` · ${failed} rejected` : ""}`
              : `${accepted} row(s) ${kind === "stock_adjustment" ? "submitted for approval" : "submitted as counts"}. No stock has been posted.`,
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
    state.rows.length <= 5000 &&
    state.previewed &&
    !state.error &&
    state.parseErrors.length === 0 &&
    !state.outcome &&
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
        {isOperational(kind) ? (
          <button
            className="text-sm font-medium underline"
            type="button"
            onClick={() =>
              downloadCsv(
                config.templateFileName,
                `${OPERATIONAL_HEADERS[kind]}\r\n`,
              )
            }
          >
            Download template
          </button>
        ) : (
          <a
            className="text-sm font-medium text-foreground underline decoration-border underline-offset-4"
            href={IMPORT_TEMPLATES[kind].templatePath}
            download={config.templateFileName}
          >
            Download template
          </a>
        )}
        <input
          key={`${state.fileName}:${state.fileHash}`}
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

      {state.rows.length > 5000 ? (
        <p className="text-sm text-danger">
          This file exceeds the 5,000-row limit.
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

      {state.previewErrors.length > 0 ? (
        <ErrorTable errors={state.previewErrors} title="Server row errors" />
      ) : null}
      {[...state.parseErrors, ...state.previewErrors].length > 0 ? (
        <Button
          variant="tertiary"
          onPress={() =>
            downloadCsv(
              `${kind}-errors.csv`,
              errorCsv([...state.parseErrors, ...state.previewErrors]),
            )
          }
        >
          Download errors
        </Button>
      ) : null}
      {kind === "stock_adjustment" &&
      state.previewed &&
      state.partitions.length > 0 ? (
        <div>
          <h3 className="font-semibold">Projected totals (base units)</h3>
          <DataTable
            empty={null}
            rows={state.partitions.map((part, index) => ({
              ...part,
              id: String(index),
            }))}
            columns={[
              {
                key: "product",
                label: "Product / UOM",
                render: (part) => `${part.productCode} / ${part.baseUomCode}`,
              },
              {
                key: "location",
                label: "Location / status / lot",
                render: (part) =>
                  `${part.locationCode} / ${part.stockStatus} / ${part.lotNumber ?? "—"}`,
              },
              {
                key: "added",
                label: "Added",
                render: (part) => displayBase(String(part.positiveBase)),
              },
              {
                key: "removed",
                label: "Removed",
                render: (part) => displayBase(String(part.negativeBase)),
              },
              {
                key: "net",
                label: "Net",
                render: (part) => displayBase(String(part.netDeltaBase)),
              },
              {
                key: "current",
                label: "Current",
                render: (part) => displayBase(String(part.currentBase)),
              },
              {
                key: "projected",
                label: "Projected",
                render: (part) => displayBase(String(part.projectedBase)),
              },
            ]}
          />
        </div>
      ) : null}
      {kind === "cycle_count" &&
      state.previewed &&
      state.countedLines.length > 0 ? (
        <div>
          <h3 className="font-semibold">Counted quantities (base units)</h3>
          <DataTable
            empty={null}
            rows={state.countedLines.map((line) => ({
              ...line,
              id: String(line.rowNumber),
            }))}
            columns={[
              {
                key: "row",
                label: "Row",
                render: (line) => String(line.rowNumber),
              },
              {
                key: "counted",
                label: "Counted",
                render: (line) => displayBase(String(line.countedBase)),
              },
              { key: "status", label: "Status", render: (line) => line.status },
            ]}
          />
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          isDisabled={
            busy ||
            state.rows.length === 0 ||
            state.rows.length > 5000 ||
            hasHeaderProblem
          }
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
          {kind === "stock_adjustment"
            ? "Submit for approval"
            : kind === "cycle_count"
              ? "Submit count"
              : "Commit"}
        </Button>
        <Button
          variant="tertiary"
          isDisabled={busy}
          onPress={() => setState(emptyFileState())}
        >
          Cancel
        </Button>
        {isOperational(kind) ? (
          <span className="text-xs text-muted">
            Submission stages the request; stock changes only after separate
            approval.
          </span>
        ) : null}
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

function RunHistory({
  canNational,
  canOperational,
}: {
  canNational: boolean;
  canOperational: boolean;
}) {
  const runs = useQuery(api.imports.runs.list, canNational ? {} : "skip");
  const operationalRuns = useQuery(
    api.imports.operational_history.list,
    canOperational ? {} : "skip",
  );
  const [operationalSelected, setOperationalSelected] = useState<{
    runKey: string;
    importType: "stock_adjustment" | "cycle_count";
  } | null>(null);
  const operationalDetail = useQuery(
    api.imports.operational_history.detail,
    canOperational && operationalSelected ? operationalSelected : "skip",
  );
  const [selected, setSelected] = useState<{
    runKey: string;
    importType: ImportKind;
  } | null>(null);
  const detail = useQuery(
    api.imports.runs.detail,
    canNational && selected
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
      {canNational ? (
        <section className="grid gap-3">
          <h2 className="font-semibold">
            Product and opening-stock runs · national
          </h2>
          {runs === undefined ? (
            <p>Loading national history…</p>
          ) : (
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
          )}
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
        </section>
      ) : null}
      {canOperational ? (
        <section className="grid gap-3">
          <h2 className="font-semibold">Adjustment and count runs · scoped</h2>
          {operationalRuns === undefined ? (
            <p>Loading scoped history…</p>
          ) : (
            <DataTable
              empty={
                <EmptyPanel
                  title="No scoped operational imports yet"
                  description="Submitted adjustments and counts in your authorized locations appear here."
                />
              }
              rows={operationalRuns.map((run, index) => ({
                ...run,
                id: `${run.importType}:${run.runKey}:${index}`,
              }))}
              columns={[
                {
                  key: "run",
                  label: "Run",
                  render: (run) => (
                    <button
                      type="button"
                      className="underline"
                      onClick={() =>
                        setOperationalSelected({
                          runKey: run.runKey,
                          importType: run.importType as
                            "stock_adjustment" | "cycle_count",
                        })
                      }
                    >
                      {run.runKey.slice(0, 8)}
                    </button>
                  ),
                },
                {
                  key: "type",
                  label: "Type",
                  render: (run) =>
                    CONFIG[run.importType as keyof typeof OPERATIONAL_CONFIG]
                      .label,
                },
                {
                  key: "status",
                  label: "Status",
                  render: (run) => (
                    <StatusPill
                      tone={run.status === "failed" ? "danger" : "success"}
                    >
                      {run.status}
                    </StatusPill>
                  ),
                },
                {
                  key: "rows",
                  label: "Rows",
                  render: (run) => String(run.rowCount),
                },
                {
                  key: "rejected",
                  label: "Rejected",
                  render: (run) => String(run.failedCount),
                },
                {
                  key: "when",
                  label: "When",
                  render: (run) =>
                    new Intl.DateTimeFormat("en-PH", {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }).format(run.createdAt),
                },
              ]}
            />
          )}
          {operationalSelected && operationalDetail ? (
            <div className="rounded-xl border border-border bg-surface p-5">
              <h3 className="font-semibold">
                {CONFIG[operationalSelected.importType].label} ·{" "}
                {operationalSelected.runKey.slice(0, 8)}
              </h3>
              <p className="text-sm text-muted">
                {operationalDetail.runs.length} chunk(s) recorded ·{" "}
                {operationalDetail.runs.map((run) => run.status).join(", ")}
              </p>
              {operationalDetail.errors.length ? (
                <ErrorTable
                  title="Recorded row errors"
                  errors={operationalDetail.errors.map((error) => ({
                    rowNumber: error.rowNumber,
                    column: error.column,
                    code: error.code,
                    message: error.message,
                  }))}
                />
              ) : (
                <p>No row errors were recorded for this run.</p>
              )}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

export function ImportsWorkspace({ setupMessage }: { setupMessage: string }) {
  const permissions = useQuery(api.lib.capabilities.currentPermissions, {});
  const [asOf] = useState(() => Date.now());
  const tree = useQuery(api.org.queries.tree, permissions ? { asOf } : "skip");
  const canNational = Boolean(
    permissions &&
    (permissions.role === "super_admin" ||
      (permissions.role === "admin" &&
        tree?.some(
          (unit) =>
            unit._id === permissions.orgUnitId && unit.typeCode === "NATIONAL",
        ))),
  );
  const canAdjust =
    permissions?.capabilities.includes("inventory.adjustment.request") ?? false;
  const canCount =
    permissions?.capabilities.includes("inventory.count.submit") ?? false;
  const canOperational = canAdjust || canCount;
  const [tab, setTab] = useState<WorkspaceKind | "history">("products");
  const [files, setFiles] = useState<Record<WorkspaceKind, FileState>>({
    products: emptyFileState(),
    opening_stock: emptyFileState(),
    stock_adjustment: emptyFileState(),
    cycle_count: emptyFileState(),
  });

  const tabs: { key: WorkspaceKind | "history"; label: string }[] = [
    ...(canNational
      ? [
          { key: "products" as const, label: CONFIG.products.label },
          { key: "opening_stock" as const, label: CONFIG.opening_stock.label },
        ]
      : []),
    ...(canAdjust
      ? [
          {
            key: "stock_adjustment" as const,
            label: CONFIG.stock_adjustment.label,
          },
        ]
      : []),
    ...(canCount
      ? [{ key: "cycle_count" as const, label: CONFIG.cycle_count.label }]
      : []),
    { key: "history", label: "Run history" },
  ];
  // A permission or organizational reassignment must immediately unmount a now-forbidden section.
  const activeTab = tabs.some((item) => item.key === tab) ? tab : tabs[0]!.key;

  return (
    <div className="grid gap-6">
      <p className="text-xs font-medium text-muted">{setupMessage}</p>
      <div className="flex flex-wrap gap-2">
        {tabs.map((item) => (
          <Button
            key={item.key}
            onPress={() => setTab(item.key)}
            size="sm"
            variant={activeTab === item.key ? "primary" : "tertiary"}
          >
            {item.label}
          </Button>
        ))}
      </div>
      {activeTab === "history" ? (
        <RunHistory canNational={canNational} canOperational={canOperational} />
      ) : (
        <ImportSection
          kind={activeTab}
          setState={(next) =>
            setFiles((current) => ({ ...current, [activeTab]: next }))
          }
          state={files[activeTab]}
        />
      )}
    </div>
  );
}
