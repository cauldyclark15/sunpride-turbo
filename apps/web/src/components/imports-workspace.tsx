"use client";
import { formatDateTime, formatMonth, formatStatus } from "../lib/format";

import { Button } from "@heroui/react";
import { Card } from "@sunpride/ui";
import { useRef, useState } from "react";
import { apiFetch, mutate, useApi, useLive } from "../lib/api";
import { usePermissions, useSession } from "../lib/auth";
import { parseImportFile, type ParsedCsv } from "../lib/csv";
import {
  downloadCsv,
  errorCsv,
  OPERATIONAL_HEADERS,
  type ImportError,
} from "../lib/import-csv-export";
import {
  businessPayload,
  chunkRows,
  countSessionChunks,
  PRODUCT_MASTER_HEADERS,
  OPENING_STOCK_HEADERS,
  PRICE_HEADERS,
  TARGET_HEADERS,
} from "../lib/import-templates";
import { MCP_HEADERS, type McpFormat } from "../lib/mcp-import-format";
import {
  MIGRATION_HEADERS,
  isMigration,
  type MigrationKind,
} from "./spec-masters/migration-model";
import { MigrationReview } from "./spec-masters/migration-review";
import { CustomerUpload } from "./customer-upload/customer-upload";
import { CUSTOMER_HEADERS } from "../lib/customer-upload";

type Kind =
  | "products"
  | "prices"
  | "opening_stock"
  | "cycle_count"
  | "stock_adjustment"
  | "mcp"
  | "targets"
  | "store_upload"
  | MigrationKind;
const TASKS: { kind: Kind; label: string; description: string }[] = [
  {
    kind: "store_upload",
    label: "Customers",
    description:
      "Add or update customers from Sunpride's customer template (Excel or CSV), with a row-by-row report.",
  },
  {
    kind: "customers",
    label: "Customer cutover",
    description: "Stage legacy/SAP accounting customers for duplicate review.",
  },
  {
    kind: "outlet_universe",
    label: "Outlet universe cutover",
    description: "Clean physical stores and map accounting customers.",
  },
  {
    kind: "route_master",
    label: "Route master cutover",
    description: "Stage route identities, territory mappings and cycle days.",
  },
  {
    kind: "open_ar",
    label: "Open AR cutover",
    description: "Stage source invoices for review, never payment posting.",
  },
  {
    kind: "products",
    label: "Products",
    description: "Set up product names, units and barcodes.",
  },
  {
    kind: "prices",
    label: "Prices",
    description: "Give the sales team a dated price list.",
  },
  {
    kind: "opening_stock",
    label: "Opening stock",
    description: "Start a location with its approved stock.",
  },
  {
    kind: "cycle_count",
    label: "Stock count",
    description: "Check a complete count without showing expected stock.",
  },
  {
    kind: "stock_adjustment",
    label: "Adjustments",
    description: "Validate stock corrections for separate approval.",
  },
  {
    kind: "mcp",
    label: "Route plans",
    description: "Load stores and visits into a draft monthly plan.",
  },
  {
    kind: "targets",
    label: "Sales targets",
    description: "Set the monthly goal so managers can see who is behind.",
  },
];
type Preview = {
  accepted: number;
  errors: ImportError[];
  commitAvailable?: boolean;
  notice?: string;
  lines?: { rowNumber: number; countedBase: number; status: string }[];
};
type Receipt = {
  accepted: number;
  failed: number;
  duplicate: boolean;
  errors: ImportError[];
};
type Run = {
  id: string;
  kind: Kind;
  status: string;
  rowCount: number;
  accepted: number;
  failed: number;
  createdAt: number;
  errors: ImportError[];
};
const headersFor = (kind: Kind, format: McpFormat): string[] =>
  kind === "products"
    ? PRODUCT_MASTER_HEADERS
    : kind === "opening_stock"
      ? OPENING_STOCK_HEADERS
      : kind === "prices"
        ? PRICE_HEADERS
        : kind === "targets"
          ? TARGET_HEADERS
          : kind === "mcp"
            ? MCP_HEADERS[format].split(",")
            : isMigration(kind)
              ? MIGRATION_HEADERS[kind].split(",")
              : kind === "store_upload"
                ? [...CUSTOMER_HEADERS]
                : OPERATIONAL_HEADERS[kind].split(",");

function Errors({ errors, kind }: { errors: ImportError[]; kind: Kind }) {
  if (!errors.length) return null;
  return (
    <section className="grid gap-3" aria-label="Rows to fix">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Rejected rows</h3>
        <Button
          variant="outline"
          onPress={() => downloadCsv(`${kind}-errors.csv`, errorCsv(errors))}
        >
          Download errors
        </Button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              <th className="p-3">Row</th>
              <th>Field</th>
              <th>What to fix</th>
            </tr>
          </thead>
          <tbody>
            {errors.slice(0, 100).map((e, i) => (
              <tr
                className="border-t border-separator"
                key={`${e.rowNumber}-${i}`}
              >
                <td className="p-3">{e.rowNumber}</td>
                <td>{e.column?.replaceAll("_", " ") ?? "File"}</td>
                <td>{e.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {errors.length > 100 && (
        <p className="text-sm text-muted">
          Showing 100 of {errors.length} errors. Download the complete list.
        </p>
      )}
    </section>
  );
}

function Loader({ kind }: { kind: Kind }) {
  const [format, setFormat] = useState<McpFormat>("mcp_visits");
  const [planId, setPlanId] = useState("");
  const [fields, setFields] = useState({
    month: "",
    priceListCode: "",
    channelKey: "",
    effectiveFrom: "",
  });
  const [sourceReference, setSource] = useState("");
  const [file, setFile] = useState<
    (ParsedCsv & { fileHash: string; name: string }) | null
  >(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [outcome, setOutcome] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const epoch = useRef(0);
  const plans = useApi<{
    rows: { id: string; assignee: string; month: string; version: number }[];
    truncated: boolean;
  }>(kind === "mcp" ? ["imports", "plans"] : null, "/api/v1/imports/plans");
  const business = kind === "prices" || kind === "targets";
  const history = useApi<{ rows: Run[]; next: string | null }>(
    business ? null : ["imports", "runs", kind, cursor],
    ({ signal }) =>
      apiFetch("/api/v1/imports/runs", {
        query: { kind, cursor: cursor ?? undefined },
        signal,
      }),
  );
  useLive(["imports"], [["imports"]]);
  const headers = headersFor(kind, format);
  const task = TASKS.find((t) => t.kind === kind)!;
  const reset = () => {
    epoch.current++;
    setFile(null);
    setPreview(null);
    setMessage("");
    setOutcome("");
  };
  const invalidate = () => {
    epoch.current++;
    setPreview(null);
    setMessage("");
    setOutcome("");
  };
  const request = (rows: ParsedCsv["rows"]) => ({
    rows,
    header: file!.header,
    sourceReference,
    planId: kind === "mcp" ? planId : undefined,
    format: kind === "mcp" ? format : undefined,
  });
  async function upload(picked: File) {
    reset();
    const current = epoch.current;
    setBusy(true);
    try {
      const parsed = await parseImportFile(picked, headers);
      if (current === epoch.current) setFile({ ...parsed, name: picked.name });
    } catch (e) {
      if (current === epoch.current)
        setMessage(
          e instanceof Error ? e.message : "Could not read this file.",
        );
    } finally {
      if (current === epoch.current) setBusy(false);
    }
  }
  async function check() {
    if (!file || file.errors.length || busy) return;
    const current = ++epoch.current;
    setBusy(true);
    setPreview(null);
    setMessage("");
    setOutcome("");
    try {
      if (business) {
        const result = businessPayload(kind, file.rows, fields);
        setPreview({
          accepted: result.errors.length ? 0 : file.rows.length,
          errors: result.errors,
        });
      } else {
        const groups =
          kind === "cycle_count" ? countSessionChunks(file.rows) : [file.rows];
        const results: Preview[] = [];
        for (const rows of groups)
          results.push(
            await apiFetch<Preview>(`/api/v1/imports/${kind}/preview`, {
              method: "POST",
              body: request(rows),
            }),
          );
        if (current === epoch.current)
          setPreview({
            accepted: results.reduce((n, r) => n + r.accepted, 0),
            errors: results.flatMap((r) => r.errors),
            lines: results.flatMap((r) => r.lines ?? []),
            commitAvailable: results.every((r) => r.commitAvailable !== false),
            notice: results.find((r) => r.notice)?.notice,
          });
      }
    } catch (e) {
      if (current === epoch.current)
        setMessage(
          e instanceof Error
            ? e.message
            : "Validation failed. Nothing was loaded.",
        );
    } finally {
      if (current === epoch.current) setBusy(false);
    }
  }
  async function commit() {
    if (
      !file ||
      !preview ||
      preview.errors.length ||
      !preview.accepted ||
      preview.commitAvailable === false ||
      busy
    )
      return;
    setBusy(true);
    setMessage("");
    setOutcome("");
    const current = ++epoch.current;
    let saved = 0;
    try {
      if (business) {
        const payload = businessPayload(kind, file.rows, fields);
        if (payload.errors.length) {
          setPreview({ accepted: 0, errors: payload.errors });
          return;
        }
        const response = await mutate<{
          ok?: boolean;
          errors?: { row: number; message: string }[];
        }>(
          kind === "targets"
            ? "/api/v1/targets/import"
            : "/api/v1/pricing/price-lists/import",
          payload.body,
          {
            idempotencyKey: `${kind}:${file.fileHash}:${JSON.stringify(fields)}`,
            invalidate: [["analytics"], ["pricing"]],
          },
        );
        const errors = (response.errors ?? []).map((e) => ({
          rowNumber: e.row,
          code: "invalid_format",
          message: e.message,
        }));
        if (
          errors.length ||
          response.ok === false ||
          (kind === "prices" && response.ok !== true)
        ) {
          setPreview({ accepted: 0, errors });
          setMessage(
            "The server did not accept this file. Review the rows and try again.",
          );
          return;
        }
        saved = file.rows.length;
      } else {
        const chunks =
          kind === "cycle_count"
            ? countSessionChunks(file.rows)
            : chunkRows(file.rows);
        for (let i = 0; i < chunks.length; i++) {
          const runKey =
            kind === "mcp" ? `${planId}:${file.fileHash}` : file.fileHash;
          const idempotencyKey = `${kind}:${runKey}:${i}`;
          const result = await mutate<Receipt>(
            `/api/v1/imports/${kind}/commit`,
            {
              ...request(chunks[i]!),
              runKey,
              chunkIndex: i,
              idempotencyKey,
              fileHash: file.fileHash,
              rowCount: file.rows.length,
            },
            { idempotencyKey, invalidate: [["imports"]] },
          );
          if (result.errors.length || result.failed) {
            setPreview({ accepted: 0, errors: result.errors });
            throw new Error(
              `Stopped after ${saved} rows were confirmed. This chunk was not loaded; fix its errors before retrying.`,
            );
          }
          saved += result.accepted;
        }
      }
      if (current === epoch.current) {
        setOutcome(
          business
            ? `${saved} rows loaded.`
            : isMigration(kind)
              ? `${saved} rows staged only. Review the cutover queue below before applying a master or AR replica.`
              : `${saved} rows confirmed. Repeated file submissions do not add a second copy.`,
        );
        setPreview(null);
      }
    } catch (e) {
      if (current === epoch.current)
        setMessage(
          e instanceof Error
            ? e.message
            : `Connection interrupted after ${saved} confirmed rows. Retry the same file to check its receipts.`,
        );
    } finally {
      if (current === epoch.current) setBusy(false);
    }
  }
  const errors = [...(file?.errors ?? []), ...(preview?.errors ?? [])];
  return (
    <div className="grid gap-5">
      <Card label={kind === "mcp" ? "Route sheets" : task.label}>
        <div className="grid gap-4">
          <p className="text-sm text-muted">{task.description}</p>
          <p className="text-sm">
            {business
              ? "Download the template, fill it in, then preview. The owning service validates and saves the complete file."
              : "Download the template, fill it in, then preview. Each chunk of up to 100 rows is all-or-nothing. Count sessions stay whole. Earlier completed chunks stay saved if a later chunk fails."}
          </p>
          <Button
            variant="outline"
            onPress={() =>
              downloadCsv(
                `${kind.replaceAll("_", "-")}.csv`,
                `${headers.join(",")}\r\n`,
              )
            }
          >
            Template
          </Button>
          {kind === "mcp" && (
            <>
              <label>
                Draft plan
                <select
                  aria-label="Draft plan"
                  value={planId}
                  disabled={busy}
                  onChange={(e) => {
                    setPlanId(e.target.value);
                    invalidate();
                  }}
                >
                  <option value="">Choose a draft plan</option>
                  {plans.data?.rows.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.assignee} · {formatMonth(p.month)} · version{" "}
                      {p.version}
                    </option>
                  ))}
                </select>
              </label>
              {plans.error && <p role="alert">{plans.error.message}</p>}
              {plans.data?.truncated && (
                <p>
                  Only the first 100 drafts are listed. Open Coverage plans to
                  find an older draft.
                </p>
              )}
              <label>
                Sheet type
                <select
                  aria-label="Sheet type"
                  value={format}
                  disabled={busy}
                  onChange={(e) => {
                    setFormat(e.target.value as McpFormat);
                    reset();
                  }}
                >
                  <option value="mcp_visits">Dated visits</option>
                  <option value="route_sheet">Route defaults</option>
                </select>
              </label>
            </>
          )}
          {kind === "opening_stock" && (
            <label>
              Source reference
              <input
                aria-label="Source reference"
                value={sourceReference}
                disabled={busy}
                onChange={(e) => {
                  setSource(e.target.value);
                  invalidate();
                }}
              />
            </label>
          )}
          {kind === "targets" && (
            <label>
              Target month
              <input
                aria-label="Target month"
                type="month"
                value={fields.month}
                disabled={busy}
                onChange={(e) => {
                  setFields({ ...fields, month: e.target.value });
                  invalidate();
                }}
              />
            </label>
          )}
          {kind === "prices" && (
            <>
              <label>
                Price-list code
                <input
                  aria-label="Price-list code"
                  value={fields.priceListCode}
                  disabled={busy}
                  onChange={(e) => {
                    setFields({ ...fields, priceListCode: e.target.value });
                    invalidate();
                  }}
                />
              </label>
              <label>
                Channel
                <input
                  aria-label="Channel"
                  value={fields.channelKey}
                  disabled={busy}
                  onChange={(e) => {
                    setFields({ ...fields, channelKey: e.target.value });
                    invalidate();
                  }}
                />
              </label>
              <label>
                Effective date (Manila)
                <input
                  aria-label="Effective date (Manila)"
                  type="date"
                  value={fields.effectiveFrom}
                  disabled={busy}
                  onChange={(e) => {
                    setFields({ ...fields, effectiveFrom: e.target.value });
                    invalidate();
                  }}
                />
              </label>
            </>
          )}
          {business && (
            <p className="text-sm text-muted">
              Amounts are whole centavos: ₱1.00 is 100. Codes must be stored as
              text in Excel. The server checks scope and existing records before
              saving.
            </p>
          )}
          <label className="grid gap-2">
            Upload file
            <input
              aria-label="CSV or Excel file"
              type="file"
              accept=".csv,.xlsx"
              disabled={busy}
              onChange={(e) => {
                const chosen = e.target.files?.[0];
                if (chosen) void upload(chosen);
                e.target.value = "";
              }}
            />
          </label>
          {file && (
            <p>
              {file.name} · {file.rows.length} rows
            </p>
          )}
          {message && <p role="alert">{message}</p>}
          {outcome && <p role="status">{outcome}</p>}
          {preview && (
            <>
              <p>
                {preview.accepted} valid · {preview.errors.length} errors
              </p>
              {preview.notice && <p role="status">{preview.notice}</p>}
              {kind === "cycle_count" &&
                preview.lines?.map((line) => (
                  <p key={line.rowNumber}>
                    Row {line.rowNumber} · Counted {line.countedBase} base units
                    · {line.status}
                  </p>
                ))}
            </>
          )}
          <Errors errors={errors} kind={kind} />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              isDisabled={
                !file ||
                !!file.errors.length ||
                busy ||
                (kind === "mcp" && !planId)
              }
              onPress={() => void check()}
            >
              Preview file
            </Button>
            <Button
              variant="primary"
              isDisabled={
                !preview?.accepted ||
                !!errors.length ||
                preview.commitAvailable === false ||
                busy
              }
              onPress={() => void commit()}
            >
              {kind === "mcp" ? "Merge rows" : "Load rows"}
            </Button>
            <Button variant="ghost" isDisabled={busy} onPress={reset}>
              Cancel
            </Button>
          </div>
        </div>
      </Card>
      {!business && (
        <Card label="Run history">
          <div className="grid gap-3">
            {history.error ? (
              <p role="alert">{history.error.message}</p>
            ) : !history.data ? (
              <p>Loading history…</p>
            ) : (
              <>
                {!history.data.rows.length && <p>No imports on this page.</p>}
                {history.data.rows.map((run) => (
                  <div key={run.id} className="border-b border-separator py-3">
                    <p>
                      {formatDateTime(run.createdAt)} ·{" "}
                      {formatStatus(run.status)}
                    </p>
                    <p>
                      {run.accepted} loaded · {run.failed} not loaded
                    </p>
                    <Errors errors={run.errors} kind={kind} />
                  </div>
                ))}
                <div className="flex gap-2">
                  {cursor && (
                    <Button variant="outline" onPress={() => setCursor(null)}>
                      Latest runs
                    </Button>
                  )}
                  {history.data.next && (
                    <Button
                      variant="outline"
                      onPress={() => setCursor(history.data!.next)}
                    >
                      More history
                    </Button>
                  )}
                </div>
              </>
            )}
          </div>
        </Card>
      )}
      {business && (
        <a
          className="text-sm underline"
          href={kind === "targets" ? "/sales" : "/master-data"}
        >
          {kind === "targets"
            ? "Review sales against targets"
            : "Review product and pricing setup"}
        </a>
      )}
    </div>
  );
}

export function ImportsWorkspace(_props: { setupMessage: string }) {
  void _props;
  const { can } = usePermissions();
  const { profile, me } = useSession();
  const [selected, setSelected] = useState<Kind | null>(null);
  const options = useApi<{ kinds: Kind[]; unavailable: Kind[] }>(
    profile?.active ? ["imports", "options"] : null,
    "/api/v1/imports/options",
  );
  const available = TASKS.filter((t) =>
    t.kind === "targets"
      ? can("target.manage")
      : t.kind === "prices" || t.kind === "store_upload"
        ? can("masterdata.manage")
        : options.data?.kinds.includes(t.kind),
  );
  const active = available.some((t) => t.kind === selected) ? selected : null;
  return (
    <div className="grid gap-6">
      <header>
        <h2 className="text-xl font-medium">What do you want to load?</h2>
        <p className="mt-2 text-sm text-muted">
          Keep sales goals, prices, stock and route plans ready for the team.
          Start with the file that needs attention.
        </p>
      </header>
      {options.error && <p role="alert">{options.error.message}</p>}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {available.map((task) => (
          <button
            key={task.kind}
            type="button"
            aria-label={task.label}
            aria-pressed={active === task.kind}
            onClick={() => setSelected(task.kind)}
            className={`rounded-xl border p-4 text-left transition-colors ${active === task.kind ? "border-foreground bg-default" : "border-separator hover:bg-default"}`}
          >
            <span className="block font-medium">{task.label}</span>
            <span className="mt-2 block text-sm text-muted">
              {task.description}
            </span>
            {options.data?.unavailable.includes(task.kind) && (
              <span className="mt-2 block text-xs text-muted">
                Validation only · submission not yet connected
              </span>
            )}
          </button>
        ))}
      </div>
      {active === "store_upload" && <CustomerUpload />}
      {active && active !== "store_upload" && (
        <Loader
          key={`${profile?.id}:${me?.scope?.fingerprint}:${active}`}
          kind={active}
        />
      )}
      {active && isMigration(active) && <MigrationReview />}
      {!active && (
        <p className="text-sm text-muted">
          Choose a task to download its template and check a file before
          loading.
        </p>
      )}
    </div>
  );
}
