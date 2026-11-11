"use client";

/**
 * SP-0169 "Upload customers" (stores) — five-step flow shared by the Stores page and the
 * imports workspace:
 *   1 Upload file (template download) → 2 Validate (instant browser checks, then server checks
 *   against stores, channels, areas and scope) → 3 Preview (cell-level errors) → 4 Import
 *   (background job; live counts by polling) → 5 Result (report CSV, resume / retry failed).
 */
import { Button } from "@heroui/react";
import { Card } from "@sunpride/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, useApi, useLive } from "../../lib/api";
import { parseImportFile } from "../../lib/csv";
import { downloadCsv } from "../../lib/import-csv-export";
import {
  CUSTOMER_HEADERS,
  PREVIEW_BATCH,
  STATUS_LABEL,
  STEPS,
  STORE_UPLOAD_API,
  downloadTemplate,
  errorIndex,
  errorsCsv,
  isLive,
  mergePreviews,
  percent,
  reportCsv,
  syncValidate,
  type PreviewResult,
  type RunRow,
  type RunSummary,
  type Step,
  type UploadError,
  type UploadRow,
} from "../../lib/customer-upload";

type Picked = {
  name: string;
  header: string[];
  rows: UploadRow[];
};

const label = (column: string) => column.replaceAll("_", " ");
const when = (ms: number | null) =>
  ms ? new Date(ms).toLocaleString("en-PH", { timeZone: "Asia/Manila" }) : "—";

export function UploadStepper({ step }: { step: Step }) {
  return (
    <ol className="flex flex-wrap gap-2" aria-label="Upload steps">
      {STEPS.map((s) => {
        const state =
          s.step < step ? "done" : s.step === step ? "current" : "todo";
        return (
          <li
            key={s.step}
            aria-current={state === "current" ? "step" : undefined}
            data-state={state}
            className={`flex items-center gap-2 rounded-full border px-3 py-1 text-sm ${state === "current" ? "border-foreground font-medium" : state === "done" ? "border-separator text-foreground" : "border-separator text-muted"}`}
          >
            <span
              className={`inline-flex size-5 items-center justify-center rounded-full text-xs ${state === "todo" ? "bg-default" : "bg-foreground text-background"}`}
            >
              {state === "done" ? "✓" : s.step}
            </span>
            {s.label}
          </li>
        );
      })}
    </ol>
  );
}

export function ProgressBar({
  value,
  label: text,
}: {
  value: number;
  label: string;
}) {
  return (
    <div className="grid gap-1">
      <div
        role="progressbar"
        aria-label={text}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        className="h-2 w-full overflow-hidden rounded-full bg-default"
      >
        <div
          className="h-full bg-foreground transition-all"
          style={{ width: `${value}%` }}
        />
      </div>
      <p className="text-xs text-muted">{text}</p>
    </div>
  );
}

/** Problems list: row + column + value + what to fix. */
export function ErrorList({ errors }: { errors: UploadError[] }) {
  if (!errors.length) return null;
  return (
    <ul className="grid gap-1 text-sm" aria-label="Problems found">
      {errors.slice(0, 200).map((e, i) => (
        <li key={`${e.rowNumber}-${e.column}-${i}`}>
          <span className="font-medium">
            {e.rowNumber > 1 ? `Row ${e.rowNumber}` : "File"}
            {e.column ? ` · ${label(e.column)}` : ""}
          </span>
          {e.value ? <span className="text-muted"> (“{e.value}”)</span> : null}:{" "}
          {e.message} <code className="text-xs text-muted">{e.code}</code>
        </li>
      ))}
      {errors.length > 200 && (
        <li className="text-muted">
          Showing 200 of {errors.length}. Download the errors file for all.
        </li>
      )}
    </ul>
  );
}

/** Row table with the exact bad cells marked; message on hover and inline under the row. */
export function PreviewTable({
  rows,
  errors,
  actions,
  errorsOnly,
  limit = 200,
}: {
  rows: UploadRow[];
  errors: UploadError[];
  actions?: Map<number, "new" | "update">;
  errorsOnly: boolean;
  limit?: number;
}) {
  const index = useMemo(() => errorIndex(errors), [errors]);
  const shown = rows.filter((r) => !errorsOnly || index.has(r.rowNumber));
  const columns = CUSTOMER_HEADERS;
  return (
    <div className="grid gap-2">
      <div className="max-h-[60vh] overflow-auto rounded-lg border border-separator">
        <table className="w-full text-left text-xs" aria-label="Rows preview">
          <thead className="sticky top-0 bg-background">
            <tr>
              <th className="p-2">Row</th>
              <th className="p-2">Result</th>
              {columns.map((c) => (
                <th key={c} className="whitespace-nowrap p-2">
                  {label(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.slice(0, limit).map((r) => {
              const rowErrors = index.get(r.rowNumber);
              const all = rowErrors ? [...rowErrors.values()].flat() : [];
              return [
                <tr
                  key={r.rowNumber}
                  data-row={r.rowNumber}
                  data-invalid={all.length ? "true" : undefined}
                  className={`border-t border-separator ${all.length ? "bg-danger/5" : ""}`}
                >
                  <td className="p-2 tabular-nums">{r.rowNumber}</td>
                  <td className="whitespace-nowrap p-2">
                    {all.length
                      ? `${all.length} problem${all.length > 1 ? "s" : ""}`
                      : actions?.get(r.rowNumber) === "update"
                        ? "Update"
                        : "New"}
                  </td>
                  {columns.map((c) => {
                    const cellErrors = rowErrors?.get(c);
                    return (
                      <td
                        key={c}
                        data-column={c}
                        data-error={
                          cellErrors ? cellErrors[0]!.code : undefined
                        }
                        title={cellErrors?.map((e) => e.message).join("\n")}
                        className={`whitespace-nowrap p-2 ${cellErrors ? "font-medium text-danger outline outline-1 -outline-offset-1 outline-danger" : ""}`}
                      >
                        {r.values[c] || (cellErrors ? "(blank)" : "")}
                      </td>
                    );
                  })}
                </tr>,
                all.length ? (
                  <tr key={`${r.rowNumber}-msg`} className="bg-danger/5">
                    <td />
                    <td
                      colSpan={columns.length + 1}
                      className="p-2 pt-0 text-danger"
                    >
                      {all
                        .map(
                          (e) =>
                            `${e.column ? `${label(e.column)}: ` : ""}${e.message}`,
                        )
                        .join(" · ")}
                    </td>
                  </tr>
                ) : null,
              ];
            })}
          </tbody>
        </table>
      </div>
      {shown.length > limit && (
        <p className="text-xs text-muted">
          Showing {limit} of {shown.length} rows. Download the errors file for
          the full list.
        </p>
      )}
    </div>
  );
}

export function RunCounts({ run }: { run: RunSummary }) {
  const done = run.succeeded + run.failed;
  return (
    <div className="grid gap-3">
      <ProgressBar
        value={percent(done, run.rowCount)}
        label={`${done} of ${run.rowCount} rows processed · ${STATUS_LABEL[run.status]}`}
      />
      <dl className="grid grid-cols-3 gap-3 text-sm">
        <div>
          <dt className="text-muted">Succeeded</dt>
          <dd
            className="text-lg font-medium tabular-nums"
            data-count="succeeded"
          >
            {run.succeeded}
          </dd>
        </div>
        <div>
          <dt className="text-muted">Failed</dt>
          <dd className="text-lg font-medium tabular-nums" data-count="failed">
            {run.failed}
          </dd>
        </div>
        <div>
          <dt className="text-muted">Not yet processed</dt>
          <dd className="text-lg font-medium tabular-nums" data-count="pending">
            {run.pending}
          </dd>
        </div>
      </dl>
    </div>
  );
}

/** Step 5: what happened, the per-row report, and resume/retry. */
export function RunReport({
  run,
  rows,
  onResume,
  onRetryFailed,
  busy = false,
}: {
  run: RunSummary;
  rows: RunRow[] | null;
  onResume?: () => void;
  onRetryFailed?: () => void;
  busy?: boolean;
}) {
  const failed = (rows ?? []).filter((r) => r.status === "failed");
  return (
    <div className="grid gap-4">
      <p className="text-sm" role="status">
        <span className="font-medium">{STATUS_LABEL[run.status]}.</span>{" "}
        {run.created} new and {run.updated} updated stores saved
        {run.failed ? `, ${run.failed} rows failed` : ""}
        {run.pending ? `, ${run.pending} rows not processed` : ""}.
        {run.status === "interrupted" &&
          " The import stopped before finishing (the server restarted or lost its connection). Rows already saved are kept; resume to process only the rest."}
      </p>
      <RunCounts run={run} />
      <div className="flex flex-wrap gap-2">
        {rows && (
          <Button
            variant="outline"
            onPress={() =>
              downloadCsv(
                `${run.fileName.replace(/\.(csv|xlsx)$/i, "")}-report.csv`,
                reportCsv(rows),
              )
            }
          >
            Download report
          </Button>
        )}
        {run.status === "interrupted" && run.pending > 0 && onResume && (
          <Button isDisabled={busy} onPress={onResume}>
            Resume ({run.pending} rows)
          </Button>
        )}
        {!isLive(run.status) && run.failed > 0 && onRetryFailed && (
          <Button variant="outline" isDisabled={busy} onPress={onRetryFailed}>
            Retry failed rows ({run.failed})
          </Button>
        )}
      </div>
      {failed.length > 0 && (
        <ErrorList
          errors={failed.flatMap((r) =>
            r.errors.map((e) => ({
              rowNumber: r.rowNumber,
              column: e.column ?? undefined,
              code: e.code,
              message: e.message,
              value: e.value,
            })),
          )}
        />
      )}
    </div>
  );
}

export function RunHistory({
  rows,
  onOpen,
}: {
  rows: RunSummary[];
  onOpen: (id: string) => void;
}) {
  if (!rows.length)
    return <p className="text-sm text-muted">No uploads yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm" aria-label="Upload history">
        <thead>
          <tr className="text-muted">
            <th className="p-2">When</th>
            <th className="p-2">Who</th>
            <th className="p-2">File</th>
            <th className="p-2">Rows</th>
            <th className="p-2">Succeeded</th>
            <th className="p-2">Failed</th>
            <th className="p-2">Status</th>
            <th className="p-2" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-separator">
              <td className="p-2">{when(r.createdAt)}</td>
              <td className="p-2">{r.actorName ?? "—"}</td>
              <td className="p-2">{r.fileName}</td>
              <td className="p-2 tabular-nums">{r.rowCount}</td>
              <td className="p-2 tabular-nums">{r.succeeded}</td>
              <td className="p-2 tabular-nums">{r.failed}</td>
              <td className="p-2">{STATUS_LABEL[r.status]}</td>
              <td className="p-2">
                <Button size="sm" variant="ghost" onPress={() => onOpen(r.id)}>
                  Open
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CustomerUpload({ compact = false }: { compact?: boolean }) {
  const [step, setStep] = useState<Step>(1);
  const [file, setFile] = useState<Picked | null>(null);
  const [syncErrors, setSyncErrors] = useState<UploadError[]>([]);
  const [fileErrors, setFileErrors] = useState<UploadError[]>([]);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [checked, setChecked] = useState(0);
  const [phase, setPhase] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [message, setMessage] = useState("");
  const [run, setRun] = useState<RunSummary | null>(null);
  const [runRows, setRunRows] = useState<RunRow[] | null>(null);
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  const history = useApi<{ rows: RunSummary[]; next: string | null }>(
    ["imports", "store-upload", "runs"],
    `${STORE_UPLOAD_API}/runs`,
  );
  useLive(["imports"], [["imports", "store-upload"]]);

  const allErrors = useMemo(
    () => (preview ? preview.errors : syncErrors),
    [preview, syncErrors],
  );
  const actions = useMemo(
    () => new Map((preview?.rows ?? []).map((r) => [r.rowNumber, r.action])),
    [preview],
  );

  function reset() {
    epoch.current++;
    setStep(1);
    setFile(null);
    setSyncErrors([]);
    setFileErrors([]);
    setPreview(null);
    setChecked(0);
    setPhase("");
    setErrorsOnly(false);
    setMessage("");
    setRun(null);
    setRunRows(null);
    setBusy(false);
  }

  async function pick(chosen: File) {
    reset();
    const current = epoch.current;
    setStep(2);
    setBusy(true);
    setPhase("Checking the file in your browser…");
    try {
      const parsed = await parseImportFile(chosen, [...CUSTOMER_HEADERS]);
      if (current !== epoch.current) return;
      const picked = {
        name: chosen.name,
        header: parsed.header,
        rows: parsed.rows,
      };
      setFile(picked);
      const sync = syncValidate(parsed);
      setFileErrors(sync.fileErrors);
      setSyncErrors(sync.rowErrors);
      if (sync.fileErrors.length) {
        setPhase("");
        setStep(1);
        return;
      }
      // Asynchronous server checks, batched so progress is visible.
      setPhase("Checking stores, channels and areas on the server…");
      const parts: PreviewResult[] = [];
      for (let i = 0; i < picked.rows.length; i += PREVIEW_BATCH) {
        parts.push(
          await apiFetch<PreviewResult>(`${STORE_UPLOAD_API}/preview`, {
            method: "POST",
            body: {
              fileName: picked.name,
              header: picked.header,
              rows: picked.rows.slice(i, i + PREVIEW_BATCH),
            },
          }),
        );
        if (current !== epoch.current) return;
        setChecked(Math.min(picked.rows.length, i + PREVIEW_BATCH));
      }
      const merged = mergePreviews(parts);
      // Browser duplicate checks span the whole file; keep any the batches could not see.
      const seen = new Set(
        merged.errors.map((e) => `${e.rowNumber}:${e.column}:${e.code}`),
      );
      const extra = sync.rowErrors.filter(
        (e) => !seen.has(`${e.rowNumber}:${e.column}:${e.code}`),
      );
      setPreview(
        mergePreviews([{ ...merged, errors: [...merged.errors, ...extra] }]),
      );
      setErrorsOnly(merged.errorRowCount + extra.length > 0);
      setPhase("");
      setStep(3);
    } catch (e) {
      if (current !== epoch.current) return;
      setMessage(e instanceof Error ? e.message : "Could not check this file.");
      setStep(1);
    } finally {
      if (current === epoch.current) setBusy(false);
    }
  }

  async function start() {
    if (!file || !preview || !preview.validCount) return;
    setBusy(true);
    setMessage("");
    try {
      const created = await apiFetch<RunSummary>(`${STORE_UPLOAD_API}/runs`, {
        method: "POST",
        body: { fileName: file.name, header: file.header, rows: file.rows },
      });
      setRun(created);
      setStep(isLive(created.status) ? 4 : 5);
      if (created.duplicate)
        setMessage(
          "This exact file was uploaded before, so nothing was imported twice. Showing that upload.",
        );
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : "Could not start the import.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function open(id: string) {
    epoch.current++;
    setMessage("");
    setFile(null);
    setPreview(null);
    setRunRows(null);
    try {
      const detail = await apiFetch<{ run: RunSummary; rows: RunRow[] }>(
        `${STORE_UPLOAD_API}/runs/${id}`,
      );
      setRun(detail.run);
      setRunRows(detail.rows);
      setStep(isLive(detail.run.status) ? 4 : 5);
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : "Could not open this upload.",
      );
    }
  }

  async function resume(retryFailed: boolean) {
    if (!run) return;
    setBusy(true);
    setMessage("");
    try {
      const next = await apiFetch<RunSummary>(
        `${STORE_UPLOAD_API}/runs/${run.id}/resume`,
        { method: "POST", body: { retryFailed } },
      );
      setRun(next);
      setRunRows(null);
      setStep(isLive(next.status) ? 4 : 5);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Could not resume.");
    } finally {
      setBusy(false);
    }
  }

  // Step 4: poll the run; a dropped connection keeps retrying and the job keeps running.
  const runId = run?.id;
  const live = run ? isLive(run.status) : false;
  useEffect(() => {
    if (!runId || !live) return;
    let stopped = false;
    const tick = async () => {
      try {
        const detail = await apiFetch<{ run: RunSummary }>(
          `${STORE_UPLOAD_API}/runs/${runId}`,
          { query: { rows: 0 } },
        );
        if (stopped) return;
        setOffline(false);
        setRun(detail.run);
        if (!isLive(detail.run.status)) setStep(5);
      } catch {
        if (!stopped) setOffline(true);
      }
    };
    const timer = setInterval(() => void tick(), 1000);
    void tick();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [runId, live]);
  // Step 5: load the per-row report once the run has stopped.
  useEffect(() => {
    if (!runId || live || runRows) return;
    let stopped = false;
    apiFetch<{ run: RunSummary; rows: RunRow[] }>(
      `${STORE_UPLOAD_API}/runs/${runId}`,
    )
      .then((d) => {
        if (!stopped) {
          setRun(d.run);
          setRunRows(d.rows);
        }
      })
      .catch(() => undefined);
    return () => {
      stopped = true;
    };
  }, [runId, live, runRows]);

  const filePicker = (
    <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-separator px-3 py-2 text-sm hover:bg-default">
      {file ? "Choose a corrected file" : "Choose CSV or Excel file"}
      <input
        aria-label="Customer file"
        className="sr-only"
        type="file"
        accept=".csv,.xlsx"
        disabled={busy}
        onChange={(e) => {
          const chosen = e.target.files?.[0];
          if (chosen) void pick(chosen);
          e.target.value = "";
        }}
      />
    </label>
  );

  return (
    <div className="grid gap-6" data-step={step}>
      <UploadStepper step={step} />
      {message && (
        <p role="alert" className="text-sm text-danger">
          {message}
        </p>
      )}
      {step === 1 && (
        <Card label="1 · Download the template, then upload your file">
          <div className="grid gap-3 text-sm">
            <p>
              One row per store. Required columns: customer code, name, channel,
              area, street address, city/municipality and province. An existing
              customer code updates that store; a new code adds one. Up to 5,000
              rows per file.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onPress={downloadTemplate}>
                Download template
              </Button>
              {filePicker}
            </div>
            <ErrorList errors={fileErrors} />
          </div>
        </Card>
      )}
      {step === 2 && (
        <Card label="2 · Validating">
          <div className="grid gap-3 text-sm">
            <p>{phase}</p>
            <ProgressBar
              value={file ? percent(checked, file.rows.length) : 0}
              label={
                file
                  ? `${checked} of ${file.rows.length} rows checked on the server`
                  : "Reading file"
              }
            />
            {syncErrors.length > 0 && (
              <p>
                {syncErrors.length} problem
                {syncErrors.length > 1 ? "s" : ""} found in the browser so far.
              </p>
            )}
          </div>
        </Card>
      )}
      {step === 3 && file && preview && (
        <Card label="3 · Preview">
          <div className="grid gap-4 text-sm">
            <p role="status">
              {file.name}: {preview.rowCount} rows · {preview.newCount} new ·{" "}
              {preview.updateCount} updates ·{" "}
              <span className={preview.errorRowCount ? "text-danger" : ""}>
                {preview.errorRowCount} rows with problems
              </span>
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={errorsOnly}
                  onChange={(e) => setErrorsOnly(e.target.checked)}
                />
                Show only rows with problems
              </label>
              {allErrors.length > 0 && (
                <Button
                  variant="outline"
                  onPress={() =>
                    downloadCsv(
                      `${file.name.replace(/\.(csv|xlsx)$/i, "")}-errors.csv`,
                      errorsCsv(allErrors),
                    )
                  }
                >
                  Download errors
                </Button>
              )}
              {filePicker}
            </div>
            <PreviewTable
              rows={file.rows}
              errors={allErrors}
              actions={actions}
              errorsOnly={errorsOnly}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                isDisabled={busy || !preview.validCount}
                onPress={() => void start()}
              >
                {preview.errorRowCount
                  ? `Import ${preview.validCount} valid rows, skip ${preview.errorRowCount}`
                  : `Import ${preview.validCount} rows`}
              </Button>
              <Button variant="ghost" onPress={reset}>
                Start over
              </Button>
            </div>
            {preview.errorRowCount > 0 && (
              <p className="text-muted">
                Fix the marked cells in your file and upload it again, or import
                the valid rows now — rows with problems are recorded as failed.
              </p>
            )}
          </div>
        </Card>
      )}
      {step === 4 && run && (
        <Card label="4 · Importing">
          <div className="grid gap-3 text-sm">
            <RunCounts run={run} />
            <p className="text-muted">
              The import runs on the server. You can close this window; the
              result stays in Upload history.
            </p>
            {offline && (
              <p role="alert">
                Can’t reach the server — retrying. Rows already saved are kept;
                if the server stopped, this upload will show as interrupted and
                can be resumed.
              </p>
            )}
          </div>
        </Card>
      )}
      {step === 5 && run && (
        <Card label="5 · Result">
          <div className="grid gap-3">
            <RunReport
              run={run}
              rows={runRows}
              busy={busy}
              onResume={() => void resume(false)}
              onRetryFailed={() => void resume(true)}
            />
            <div>
              <Button variant="ghost" onPress={reset}>
                Upload another file
              </Button>
            </div>
          </div>
        </Card>
      )}
      {!compact || step === 1 ? (
        <Card label="Upload history">
          {history.error ? (
            <p role="alert">{history.error.message}</p>
          ) : !history.data ? (
            <p className="text-sm">Loading history…</p>
          ) : (
            <RunHistory
              rows={history.data.rows}
              onOpen={(id) => void open(id)}
            />
          )}
        </Card>
      ) : null}
    </div>
  );
}
