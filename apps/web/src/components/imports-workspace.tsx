"use client";

import { Button, ListBox, Select } from "@heroui/react";
import { api } from "@sunpride/backend/api";
import {
  Card,
  DataTable,
  EmptyPanel,
  ListRow,
  PageHeader,
  StatusPill,
  UnderlineTabs,
  type DataColumn,
} from "@sunpride/ui";
import { useConvex, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";
import { hashText, parseCsv } from "../lib/csv";
import {
  MCP_HEADERS,
  parseMcpFile,
  type McpFormat,
} from "../lib/mcp-import-format";
import type { Id } from "../../../../packages/backend/convex/_generated/dataModel";
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
  const fallback = "Import failed. Try again or contact your administrator.";
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
    {
      key: "code",
      label: "Code",
      render: (error) => <StatusPill tone="danger">{error.code}</StatusPill>,
    },
    { key: "message", label: "Message", render: (error) => error.message },
  ];
  return (
    <div className="overflow-hidden rounded-xl border border-separator">
      <h3 className="px-4 py-3 text-[11px] font-medium uppercase tracking-wide text-muted">
        {title} · {errors.length}
      </h3>
      <DataTable
        columns={columns}
        empty={null}
        rows={errors.slice(0, 100).map((error, index) => ({
          ...error,
          id: `${error.rowNumber}-${index}`,
        }))}
      />
      {errors.length > 100 ? (
        <p className="p-3 text-xs text-muted">
          First 100 · {errors.length} total
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
          summary: `${result.accepted} valid · ${result.errorCount} rejected · ${displayBase(result.totalQuantityBase)} cases`,
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
              error: "Rows rejected. Review errors and retry.",
            });
            return;
          }
        }
      }
      setState({
        ...state,
        progress: null,
        outcome: duplicated
          ? "Already imported · No changes"
          : kind === "products"
            ? `Imported: ${created} created · ${updated} updated · ${skipped} unchanged · ${failed} rejected`
            : kind === "opening_stock"
              ? `Posted ${accepted} row(s) as ${chunks.length} movement(s)${failed > 0 ? ` · ${failed} rejected` : ""}`
              : `${accepted} ${kind === "stock_adjustment" ? "submitted for approval" : "counts submitted"} · ${failed} rejected`,
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
    <Card
      label={config.label}
      count={state.rows.length || undefined}
      actions={
        <div className="flex items-center gap-2">
          {isOperational(kind) ? (
            <Button
              variant="secondary"
              className="h-10"
              onPress={() =>
                downloadCsv(
                  config.templateFileName,
                  `${OPERATIONAL_HEADERS[kind]}\r\n`,
                )
              }
            >
              Template
            </Button>
          ) : (
            <a
              className="inline-flex h-10 items-center rounded-[10px] border border-border px-3 text-sm font-medium"
              href={IMPORT_TEMPLATES[kind].templatePath}
              download={config.templateFileName}
            >
              Template
            </a>
          )}
          <label className="inline-flex h-10 cursor-pointer items-center rounded-[10px] border border-border px-3 text-sm font-medium">
            Upload file
            <input
              key={`${state.fileName}:${state.fileHash}`}
              accept=".csv,text/csv"
              className="sr-only"
              aria-label={`Upload ${config.label} file`}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void selectFile(file);
              }}
              type="file"
            />
          </label>
        </div>
      }
    >
      <div className="grid gap-4">
        {state.fileName ? (
          <p className="text-[13px] text-muted">
            {state.fileName} · {state.rows.length} rows ·{" "}
            {state.runKey.slice(0, 8)}
          </p>
        ) : null}

        {state.rows.length > 5000 ? (
          <p className="text-sm text-danger">File exceeds 5,000 rows</p>
        ) : null}
        {hasHeaderProblem ? (
          <ErrorTable errors={state.parseErrors} title="Header mismatch" />
        ) : null}

        {!hasHeaderProblem && state.parseErrors.length > 0 ? (
          <ErrorTable errors={state.parseErrors} title="File errors" />
        ) : null}

        {state.previewErrors.length > 0 ? (
          <ErrorTable errors={state.previewErrors} title="Row errors" />
        ) : null}
        {[...state.parseErrors, ...state.previewErrors].length > 0 ? (
          <Button
            variant="secondary"
            className="h-10"
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
          <div className="grid gap-2">
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted">
              Projected · cases
            </h3>
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
          <div className="grid gap-2">
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted">
              Counted · cases
            </h3>
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
                {
                  key: "status",
                  label: "Status",
                  render: (line) => (
                    <StatusPill
                      tone={line.status === "accepted" ? "success" : "warning"}
                    >
                      {line.status}
                    </StatusPill>
                  ),
                },
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
            variant="secondary"
            className="h-10"
          >
            Preview file
          </Button>
          <Button
            isDisabled={!canCommit}
            onPress={() => void commit()}
            variant="primary"
            className="h-10"
          >
            {kind === "stock_adjustment"
              ? "Submit request"
              : kind === "cycle_count"
                ? "Submit count"
                : "Import file"}
          </Button>
          <Button
            variant="secondary"
            className="h-10"
            isDisabled={busy}
            onPress={() => setState(emptyFileState())}
          >
            Cancel
          </Button>
          {state.progress ? (
            <span className="text-sm text-muted">{state.progress}</span>
          ) : null}
        </div>

        {state.summary ? (
          <ListRow
            icon="✓"
            title="Preview"
            meta={state.summary}
            value={
              <StatusPill tone={state.blocking ? "warning" : "success"}>
                {state.blocking ? "Review" : "Ready"}
              </StatusPill>
            }
          />
        ) : null}
        {state.outcome ? (
          <ListRow
            icon="✓"
            title="Complete"
            meta={state.outcome}
            tone="success"
            value={<StatusPill tone="success">Complete</StatusPill>}
          />
        ) : null}
        {state.error ? (
          <ListRow
            icon="!"
            title="Import failed"
            meta={state.error}
            tone="danger"
            value={<StatusPill tone="danger">Failed</StatusPill>}
          />
        ) : null}
      </div>
    </Card>
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
        <div className="grid gap-4">
          <Card label="Product and stock runs" count={rows.length} flush>
            {runs === undefined ? (
              <EmptyPanel title="Loading…" />
            ) : (
              <DataTable
                columns={columns}
                empty={<EmptyPanel title="No imports yet" />}
                rows={rows}
              />
            )}
          </Card>
          {selected && detail ? (
            <Card
              label={`${IMPORT_TEMPLATES[selected.importType].label} · ${selected.runKey.slice(0, 8)}`}
            >
              <p className="text-[13px] text-muted">
                {detail.runs.length} chunks · {detail.movements.length}{" "}
                movements
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
                <p className="text-[13px] text-muted">No row errors</p>
              )}
            </Card>
          ) : null}
        </div>
      ) : null}
      {canOperational ? (
        <div className="grid gap-4">
          <Card
            label="Adjustment and count runs"
            count={operationalRuns?.length}
            flush
          >
            {operationalRuns === undefined ? (
              <EmptyPanel title="Loading…" />
            ) : (
              <DataTable
                empty={<EmptyPanel title="No runs yet" />}
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
          </Card>
          {operationalSelected && operationalDetail ? (
            <Card
              label={`${CONFIG[operationalSelected.importType].label} · ${operationalSelected.runKey.slice(0, 8)}`}
            >
              <p className="text-[13px] text-muted">
                {operationalDetail.runs.length} chunks ·{" "}
                {operationalDetail.runs.map((run) => run.status).join(" · ")}
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
                <p className="text-[13px] text-muted">No row errors</p>
              )}
            </Card>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function McpSection() {
  const convex = useConvex();
  const [month, setMonth] = useState(() =>
    new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 7),
  );
  const [cursor, setCursor] = useState<string | null>(null);
  const [planId, setPlanId] = useState<Id<"coveragePlans"> | null>(null);
  const [format, setFormat] = useState<McpFormat>("mcp_visits");
  const [file, setFile] = useState<Awaited<
    ReturnType<typeof parseMcpFile>
  > | null>(null);
  const [name, setName] = useState("");
  const [preview, setPreview] = useState<FunctionReturnType<
    typeof api.imports.mcp.preview
  > | null>(null);
  const [message, setMessage] = useState("");
  const [messageError, setMessageError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const discovery = useQuery(api.coverage.discovery.list, {
    localMonth: month,
    status: "draft",
    paginationOpts: { numItems: 20, cursor },
  });
  const history = useQuery(
    api.imports.mcp.history,
    planId
      ? { planId, paginationOpts: { numItems: 20, cursor: historyCursor } }
      : "skip",
  );
  async function select(upload: File) {
    setPreview(null);
    setMessage("");
    setMessageError(false);
    try {
      setFile(await parseMcpFile(upload, format));
      setName(upload.name);
    } catch (error) {
      setFile(null);
      setMessageError(true);
      setMessage(operationErrorMessage(error));
    }
  }
  async function check() {
    if (!planId || !file || file.errors.length) return;
    setBusy(true);
    try {
      const result = await convex.query(api.imports.mcp.preview, {
        planId,
        format,
        header: file.header,
        rows: file.rows,
        fileHash: file.fileHash,
        rowCount: file.rows.length,
      });
      setPreview(result);
      setMessageError(false);
      setMessage(
        `${result.accepted.length} accepted · ${new Set(result.rejected.map((error) => error.rowNumber)).size} rejected`,
      );
    } catch (error) {
      setPreview(null);
      setMessageError(true);
      setMessage(operationErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function commit() {
    if (!planId || !file || !preview?.accepted.length) return;
    setBusy(true);
    try {
      const accepted = new Set(preview.accepted.map((row) => row.rowNumber));
      let total = 0;
      for (let index = 0; index < file.rows.length; index += 100) {
        const rows = file.rows.slice(index, index + 100);
        if (!rows.some((row) => accepted.has(row.rowNumber))) continue;
        const result = await convex.mutation(api.imports.mcp.commit, {
          planId,
          format,
          header: file.header,
          rows,
          fileHash: file.fileHash,
          rowCount: file.rows.length,
          chunkIndex: Math.floor(index / 100),
          sourceReference: name,
        });
        total += result.acceptedCount;
      }
      setMessageError(false);
      setMessage(`${total} rows merged`);
      setPreview(null);
    } catch (error) {
      setMessageError(true);
      setMessage(operationErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  const errors: ImportError[] = [
    ...(file?.errors ?? []),
    ...(preview?.rejected ?? []),
  ];
  return (
    <>
      <Card
        label="Route sheets"
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              className="h-10"
              onPress={() =>
                downloadCsv(
                  `${format}-template.csv`,
                  `${MCP_HEADERS[format]}\r\n`,
                )
              }
            >
              Template
            </Button>
            <label className="inline-flex h-10 cursor-pointer items-center rounded-[10px] border border-border px-3 text-sm font-medium">
              Upload file
              <input
                className="sr-only"
                aria-label="Upload route sheet"
                type="file"
                accept=".csv,.xlsx"
                onChange={(event) => {
                  const upload = event.target.files?.[0];
                  if (upload) void select(upload);
                }}
              />
            </label>
          </div>
        }
      >
        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <label className="grid gap-1.5 text-[13px] font-medium">
              Month
              <input
                className="h-10 rounded-[10px] border border-border bg-surface px-3"
                type="month"
                value={month}
                onChange={(event) => {
                  setMonth(event.target.value);
                  setCursor(null);
                  setPlanId(null);
                  setPreview(null);
                }}
              />
            </label>
            <div className="grid gap-1.5 text-[13px] font-medium">
              <span>Draft plan</span>
              <Select
                aria-label="Draft plan"
                selectedKey={planId ?? "__none"}
                onSelectionChange={(key) => {
                  setPlanId(
                    key === "__none"
                      ? null
                      : (String(key) as Id<"coveragePlans">),
                  );
                  setHistoryCursor(null);
                  setPreview(null);
                }}
              >
                <Select.Trigger className="h-10 min-h-10 rounded-[10px] !border !border-border bg-surface px-3 text-sm shadow-none">
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    <ListBox.Item id="__none" textValue="Select draft">
                      Select draft
                    </ListBox.Item>
                    {discovery?.page.map((plan) => (
                      <ListBox.Item
                        key={plan.planId}
                        id={plan.planId}
                        textValue={`${plan.assigneeName} · ${plan.localMonth}`}
                      >
                        {plan.assigneeName} · {plan.localMonth}
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
            </div>
            <div className="grid gap-1.5 text-[13px] font-medium">
              <span>Sheet type</span>
              <Select
                aria-label="Sheet type"
                selectedKey={format}
                onSelectionChange={(key) => {
                  setFormat(String(key) as McpFormat);
                  setFile(null);
                  setPreview(null);
                }}
              >
                <Select.Trigger className="h-10 min-h-10 rounded-[10px] !border !border-border bg-surface px-3 text-sm shadow-none">
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    <ListBox.Item id="mcp_visits" textValue="Dated visits">
                      Dated visits
                    </ListBox.Item>
                    <ListBox.Item id="route_sheet" textValue="Route defaults">
                      Route defaults
                    </ListBox.Item>
                  </ListBox>
                </Select.Popover>
              </Select>
            </div>
          </div>
          {discovery && !discovery.isDone && (
            <Button
              variant="secondary"
              className="h-10"
              onPress={() => setCursor(discovery.continueCursor)}
            >
              More plans
            </Button>
          )}
          {file && (
            <p className="text-sm">
              {name} · {file.rows.length} rows · {file.interpretation}
            </p>
          )}
          {errors.length > 0 && (
            <>
              <ErrorTable errors={errors} title="Rejected rows" />
              <Button
                variant="secondary"
                className="h-10"
                onPress={() => downloadCsv("mcp-errors.csv", errorCsv(errors))}
              >
                Download errors
              </Button>
            </>
          )}
          {message && (
            <div role="status">
              <ListRow
                icon={messageError ? "!" : "✓"}
                title={messageError ? "Import failed" : "Import status"}
                meta={message}
                tone={messageError ? "danger" : "success"}
                value={
                  <StatusPill tone={messageError ? "danger" : "success"}>
                    {messageError ? "Failed" : preview ? "Ready" : "Complete"}
                  </StatusPill>
                }
              />
            </div>
          )}
          <div className="flex gap-2">
            <Button
              variant="secondary"
              className="h-10"
              isDisabled={
                !planId || !file?.rows.length || !!file.errors.length || busy
              }
              onPress={() => void check()}
            >
              Preview file
            </Button>
            <Button
              variant="primary"
              className="h-10"
              isDisabled={!preview?.accepted.length || busy}
              onPress={() => void commit()}
            >
              Merge rows
            </Button>
          </div>
          {preview?.accepted.length ? (
            <ListRow
              icon="✓"
              title="Ready to merge"
              meta={`${preview.accepted.length} rows`}
              tone="success"
            />
          ) : null}
        </div>
      </Card>
      {planId && (
        <Card label="History" count={history?.page.length} flush>
          {history?.page.map((run) => (
            <div key={run.runId}>
              <ListRow
                icon="▤"
                title={run.sourceReference ?? run.fileHash}
                meta={`${run.acceptedCount} accepted · ${run.rejectedCount} rejected`}
                value={
                  <StatusPill tone={run.rejectedCount ? "warning" : "success"}>
                    {run.rejectedCount ? "Review" : "Complete"}
                  </StatusPill>
                }
              />
              {run.errors.length > 0 && (
                <ErrorTable errors={run.errors} title="Row errors" />
              )}
            </div>
          ))}
          {history && !history.isDone && (
            <Button
              variant="secondary"
              className="m-4 h-10"
              onPress={() => setHistoryCursor(history.continueCursor)}
            >
              More history
            </Button>
          )}
        </Card>
      )}
    </>
  );
}

export function ImportsWorkspace(_props: { setupMessage: string }) {
  void _props;
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
  const canMcp = permissions?.capabilities.includes("mcp.plan") ?? false;
  const [tab, setTab] = useState<WorkspaceKind | "mcp" | "history">("products");
  const [files, setFiles] = useState<Record<WorkspaceKind, FileState>>({
    products: emptyFileState(),
    opening_stock: emptyFileState(),
    stock_adjustment: emptyFileState(),
    cycle_count: emptyFileState(),
  });

  const tabs: { key: WorkspaceKind | "mcp" | "history"; label: string }[] = [
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
    ...(canMcp ? [{ key: "mcp" as const, label: "MCP / route sheets" }] : []),
    { key: "history", label: "Run history" },
  ];
  // A permission or organizational reassignment must immediately unmount a now-forbidden section.
  const activeTab = tabs.some((item) => item.key === tab) ? tab : tabs[0]!.key;

  return (
    <div className="grid gap-4">
      <PageHeader
        title="Imports"
        meta={`${tabs.length - 1} types · ${Object.values(files).reduce((total, file) => total + file.rows.length, 0)} rows`}
      />
      <UnderlineTabs
        label="Import types"
        items={tabs.map((item) => [item.key, item.label] as const)}
        activeId={activeTab}
        onChange={setTab}
      />
      {activeTab === "history" ? (
        <RunHistory canNational={canNational} canOperational={canOperational} />
      ) : activeTab === "mcp" ? (
        <McpSection />
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
