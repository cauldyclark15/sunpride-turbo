"use client";

import { useState, type FormEvent } from "react";
import { mutate, useApi, useLive } from "../../lib/api";
import { Panel } from "../cockpit/kit";
import { formatPhp as cockpitPhp, formatDayTime } from "../cockpit/format";
const formatPhp = (value: number | null | undefined) =>
  cockpitPhp(value, { cents: true });

type Choice = { id: string; name: string; org_unit_id?: string };
type Register = Choice & {
  terminal_code: string;
  store_name: string;
  tolerance_centavos: string | null;
};
type Shift = {
  id: string;
  registerName: string;
  storeName: string;
  cashierName: string;
  serviceDate: string;
  openedAt: number;
  closedAt: number | null;
  status: string;
  declaredCentavos: string | null;
  expectedCentavos: string | null;
  varianceCentavos: string | null;
  closureId: string | null;
  canDecide: boolean;
};
export type StorePosWorkspace = {
  locations: Choice[];
  registers: Register[];
  devices: (Choice & { mode: string | null; register_id: string | null })[];
  people: Choice[];
  shifts: Shift[];
  canManage: boolean;
  truncated: boolean;
  transactionsEnabled: boolean;
};
const key = ["storepos", "workspace"] as const;
const control =
  "min-w-0 max-w-full w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm";
const button =
  "rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-50";
export function storeStatus(status: string) {
  return (
    (
      {
        open: "Session open",
        closed: "Count received",
        needs_review: "Cash difference needs review",
        accepted: "Difference accepted",
        investigate: "Investigate difference",
      } as Record<string, string>
    )[status] ?? "Needs review"
  );
}
function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Choice[];
}) {
  return (
    <label className="grid min-w-0 gap-1 text-sm">
      {label}
      <select
        aria-label={label}
        className={control}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Choose…</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  );
}
function useWorkspace() {
  const result = useApi<StorePosWorkspace>(key, "/api/v1/storepos/workspace");
  useLive(["storepos"], [key]);
  return result;
}
/** F-R01: extends Setup → Phones; device identity comes from the existing selection. */
export function StorePosAdmin({ deviceId }: { deviceId: string }) {
  const result = useWorkspace();
  const [registerId, setRegisterId] = useState("");
  const [mode, setMode] = useState("van");
  const [allowSwitch, setAllowSwitch] = useState(false);
  const [person, setPerson] = useState("");
  const [location, setLocation] = useState("");
  const [name, setName] = useState("");
  const [terminal, setTerminal] = useState("");
  const [tolerance, setTolerance] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const data = result.data;
  if (!data || result.error)
    return (
      <p role={result.error ? "alert" : undefined} className="text-sm">
        {result.error
          ? "Could not load POS setup. Retry from the phone list."
          : "Loading POS setup…"}
      </p>
    );
  const device = data.devices.find((d) => d.id === deviceId);
  if (!data.canManage || !device) return null;
  const selectedRegister = data.registers.find(
    (r) => r.id === (registerId || device.register_id),
  );
  async function send(path: string, body: Record<string, unknown>) {
    setBusy(true);
    setNotice("");
    try {
      await mutate(
        `/api/v1/storepos/${path}`,
        { ...body, requestKey: crypto.randomUUID() },
        { invalidate: [key] },
      );
      setNotice("Saved. Sync this handheld to receive its configuration.");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Could not save POS setup");
    } finally {
      setBusy(false);
    }
  }
  const submit =
    (path: string, body: Record<string, unknown>) => (e: FormEvent) => {
      e.preventDefault();
      void send(path, body);
    };
  return (
    <section
      aria-label="POS configuration"
      className="grid min-w-0 max-w-full gap-3 break-words border-t border-separator pt-4"
    >
      <h4 className="text-sm font-medium">POS configuration</h4>
      <p className="text-sm text-muted">
        Current mode: {device.mode === "store" ? "Store" : "Van"}. One app, one
        inventory system. Store mode includes cashier sessions, sales, split
        tender, receipts and daily closing.
      </p>
      {data.truncated && (
        <p role="alert">
          Setup list is incomplete. Narrow your organizational assignment before
          changing setup.
        </p>
      )}
      <Select
        label="Store register"
        value={registerId}
        onChange={setRegisterId}
        options={data.registers.map((r) => ({
          id: r.id,
          name: `${r.store_name} · ${r.name}`,
        }))}
      />
      {selectedRegister && (
        <p className="min-w-0 break-words text-sm text-muted">
          {selectedRegister.store_name} · {selectedRegister.name}
          <span className="block">
            Terminal · {selectedRegister.terminal_code}
          </span>
        </p>
      )}
      <form
        className="grid min-w-0 gap-2"
        onSubmit={submit("mode/set", {
          deviceId,
          mode,
          registerId: registerId || null,
          allowLocalSwitch: allowSwitch,
        })}
      >
        <label className="grid min-w-0 gap-1 text-sm">
          New mode
          <select
            aria-label="New mode"
            className={control}
            value={mode}
            onChange={(e) => setMode(e.target.value)}
          >
            <option value="van">Van</option>
            <option value="store">Store</option>
          </select>
        </label>
        <p className="text-xs text-muted">
          Close the cashier session or settle the van trip first. Manager
          switching requires a configured register PIN and a connection.
        </p>
        <button
          className={button}
          disabled={busy || data.truncated || (mode === "store" && !registerId)}
        >
          Save POS mode
        </button>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={allowSwitch}
            onChange={(e) => setAllowSwitch(e.target.checked)}
          />
          Allow manager-PIN mode switching
        </label>
      </form>
      <form
        className="grid gap-2 border-t border-separator pt-3"
        onSubmit={submit("cashiers/save", {
          registerId,
          profileId: person,
          enabled: true,
        })}
      >
        <Select
          label="Cashier"
          value={person}
          onChange={setPerson}
          options={data.people}
        />
        <div className="flex gap-2">
          <button className={button} disabled={busy || !registerId || !person}>
            Assign cashier
          </button>
          <button
            className={button}
            type="button"
            disabled={busy || !registerId || !person}
            onClick={() =>
              void send("cashiers/save", {
                registerId,
                profileId: person,
                enabled: false,
              })
            }
          >
            Remove cashier
          </button>
        </div>
      </form>
      <form
        className="grid gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (/^\d+(\.\d{1,2})?$/.test(tolerance))
            void send("policies/save", {
              registerId,
              toleranceCentavos: String(Math.round(Number(tolerance) * 100)),
            });
        }}
      >
        <label className="grid min-w-0 gap-1 text-sm">
          Allowed over/short (₱)
          <input
            className={control}
            inputMode="decimal"
            value={tolerance}
            onChange={(e) => setTolerance(e.target.value)}
          />
        </label>
        <p className="text-xs text-muted">
          Current:{" "}
          {data.registers.find((r) => r.id === registerId)
            ?.tolerance_centavos == null
            ? "Needs setup"
            : formatPhp(
                Number(
                  data.registers.find((r) => r.id === registerId)
                    ?.tolerance_centavos,
                ),
              )}
          . A larger difference goes to Decide.
        </p>
        <button
          className={button}
          disabled={busy || !registerId || !/^\d+(\.\d{1,2})?$/.test(tolerance)}
        >
          Save tolerance
        </button>
      </form>
      <details className="text-sm">
        <summary>Add register at an existing store</summary>
        <form
          className="mt-2 grid gap-2"
          onSubmit={submit("registers/save", {
            locationId: location,
            name,
            terminalCode: terminal,
          })}
        >
          <Select
            label="Inventory location"
            value={location}
            onChange={setLocation}
            options={data.locations}
          />
          <label>
            Register name
            <input
              className={control}
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            Terminal code
            <input
              className={control}
              maxLength={40}
              value={terminal}
              onChange={(e) => setTerminal(e.target.value)}
            />
          </label>
          <button
            className={button}
            disabled={busy || !location || !name.trim() || !terminal.trim()}
          >
            Create register
          </button>
        </form>
      </details>
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
    </section>
  );
}
export function StoreShiftRows({
  shifts,
  onDecide,
}: {
  shifts: Shift[];
  onDecide?: (id: string, decision: string, reason: string) => void;
}) {
  const [reasons, setReasons] = useState<Record<string, string>>({});
  return (
    <div className="grid gap-3">
      {shifts.length === 0 && (
        <p className="text-sm text-muted">No cashier sessions received.</p>
      )}
      {shifts.map((s) => (
        <article
          key={s.id}
          className="grid gap-2 border-b border-separator pb-3"
        >
          <h4 className="text-sm font-medium">
            {s.storeName} · {s.registerName}
          </h4>
          <p className="text-sm">
            {s.cashierName} · {formatDayTime(s.openedAt)} ·{" "}
            {storeStatus(s.status)}
          </p>
          {s.declaredCentavos !== null && (
            <p className="text-sm">
              Declared {formatPhp(Number(s.declaredCentavos))}
              {s.expectedCentavos !== null && (
                <>
                  {" "}
                  · Expected {formatPhp(Number(s.expectedCentavos))} ·
                  Difference {formatPhp(Number(s.varianceCentavos))}
                </>
              )}
            </p>
          )}
          {s.canDecide && onDecide && s.closureId && (
            <div className="grid gap-2">
              <label className="text-sm">
                Review reason
                <input
                  className={control}
                  maxLength={300}
                  value={reasons[s.id] ?? ""}
                  onChange={(e) =>
                    setReasons((old) => ({ ...old, [s.id]: e.target.value }))
                  }
                />
              </label>
              <div className="flex gap-2">
                {["accepted", "investigate"].map((d) => (
                  <button
                    key={d}
                    className={button}
                    disabled={!reasons[s.id]?.trim()}
                    onClick={() => onDecide(s.closureId!, d, reasons[s.id]!)}
                  >
                    {d === "accepted" ? "Accept difference" : "Investigate"}
                  </button>
                ))}
              </div>
            </div>
          )}
        </article>
      ))}
    </div>
  );
}
/** F-R01: existing Decide page, not a second approval app. */
export function StoreShiftReview() {
  const result = useWorkspace();
  const [notice, setNotice] = useState("");
  async function decide(closureId: string, decision: string, reason: string) {
    try {
      await mutate(
        "/api/v1/storepos/shifts/decide",
        { closureId, decision, reason, requestKey: crypto.randomUUID() },
        { invalidate: [key] },
      );
      setNotice("Review recorded");
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Could not record review");
    }
  }
  return (
    <Panel
      title="Store cashier sessions"
      question="Is every register's cash accounted for?"
    >
      {result.error ? (
        <p role="alert">Could not load store cashier sessions.</p>
      ) : !result.data ? (
        <p>Loading cashier sessions…</p>
      ) : (
        <>
          {result.data.truncated && (
            <p role="alert">
              Showing the latest 500 sessions; older sessions are not included.
            </p>
          )}
          <StoreShiftRows
            shifts={result.data.shifts}
            onDecide={(...args) => void decide(...args)}
          />
        </>
      )}
      {notice && <p role="status">{notice}</p>}
    </Panel>
  );
}
