"use client";
import { useState, type FormEvent } from "react";
import { mutate, useApi, useLive } from "../../lib/api";
import { usePermissions } from "../../lib/auth";
import { CompanyIdentity } from "./identity";

type Device = {
  id: string;
  label: string;
  person: string;
  status: string;
  app: string;
  handover_id: string | null;
  control: {
    id: string;
    kind: string;
    status: string;
    queued_count: number | null;
  } | null;
  assessment: { source: string; rooted: boolean; tampered: boolean } | null;
};
type Asset = {
  id: string;
  asset_tag: string;
  model: string;
  assigned_name: string | null;
  assignment_needs_review?: boolean;
  state: string;
  mdm_status: string;
  data_plan: string;
  source_ref: string;
  peripherals: Array<{ kind: string; tag: string }>;
};
type Fleet = {
  assets: Asset[];
  devices: Device[];
  truncated: boolean;
  units: Array<{ id: string; name: string }>;
  people: Array<{ id: string; name: string; org_unit_id: string }>;
  providers: Array<{ code: string; label: string; issuer: string }>;
};
const box = "grid gap-4 rounded-xl border border-border bg-surface p-5";
const button =
  "rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-50";
const input =
  "w-full rounded-lg border border-border bg-background p-2 text-sm";
const words = (s: string) => s.replaceAll("_", " ");
export const phoneLabel = (label: string) =>
  /^SAMPLE-[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(label)
    ? "Sample registered phone"
    : label;

/** F-007/F-021/F-024: same Setup shell, fleet plus controlled replacement/recovery. */
export function IntegrityFleet() {
  const { can } = usePermissions();
  const result = useApi<Fleet>(
    can("admin.manage") ? ["integrity", "fleet"] : null,
    "/api/v1/integrity/fleet",
  );
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Device | null>(null);
  useLive(can("admin.manage") ? ["integrity"] : [], [["integrity"]]);
  if (!can("admin.manage"))
    return <p>Device administration is not part of your access.</p>;
  async function send(path: string, body: unknown) {
    setBusy(true);
    setMessage("");
    try {
      await mutate(`/api/v1/integrity/${path}`, body, {
        invalidate: [["integrity"]],
        idempotencyKey: crypto.randomUUID(),
      });
      setMessage("Saved. The register will refresh.");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Could not save. Try again.");
    } finally {
      setBusy(false);
    }
  }
  async function exportRecovery(controlId: string) {
    setBusy(true);
    try {
      const response = await mutate<{ bundleJson: string }>(
        "/api/v1/integrity/recovery/export",
        { controlId, reasonCode: "supervised_evidence_reconciliation" },
      );
      const url = URL.createObjectURL(
        new Blob([response.bundleJson], {
          type: "application/json;charset=utf-8",
        }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = "Sunpride-held-work.json";
      link.click();
      URL.revokeObjectURL(url);
      setMessage(
        "Held evidence downloaded for supervised reconciliation. Nothing was replayed.",
      );
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : "Recovery could not be exported.",
      );
    } finally {
      setBusy(false);
    }
  }
  function assetForm(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    void send("fleet/save", {
      assetTag: f.get("tag"),
      orgUnitId: f.get("unit"),
      assignedProfileId: f.get("person"),
      model: f.get("model"),
      state: f.get("state"),
      dataPlan: f.get("plan"),
      mdmStatus: f.get("mdm"),
      mdmSource: f.get("source"),
      sourceRef: f.get("source"),
      note: f.get("note"),
      breakFixDueAt: f.get("due")
        ? Date.parse(`${f.get("due")}T17:00:00+08:00`)
        : null,
      peripherals: ["printer", "scanner"].flatMap((kind) =>
        f.get(kind) ? [{ kind, tag: f.get(kind) }] : [],
      ),
    });
  }
  return (
    <div className="grid gap-4">
      <section className={box}>
        <h2 className="text-lg font-semibold">Fleet & phone integrity</h2>
        <p className="text-sm text-muted">
          Which phones are ready, who has them, and what needs replacement? One
          active phone per person, across all apps.
        </p>
        {message ? <p role="status">{message}</p> : null}
        {result.error ? <p role="alert">{result.error.message}</p> : null}
        {!result.data ? (
          <p>Loading fleet…</p>
        ) : (
          <>
            {result.data.truncated ? (
              <p role="alert">
                This view is incomplete. More than 500 assets or phones need a
                narrower register view.
              </p>
            ) : null}
            <div className="flex flex-wrap gap-6 text-sm">
              <p>
                {result.data.assets.filter((a) => a.state === "spare").length}{" "}
                spares available
              </p>
              <p>
                {result.data.assets.filter((a) => a.state === "repair").length}{" "}
                in repair
              </p>
              <p>
                {
                  result.data.assets.filter(
                    (a) => a.mdm_status === "noncompliant",
                  ).length
                }{" "}
                MDM concerns
              </p>
            </div>
            <h3 className="font-medium">Assigned phones</h3>
            {result.data.devices.map((d) => (
              <article
                key={d.id}
                className="flex flex-wrap items-start justify-between gap-3 border-t border-border pt-3"
              >
                <div>
                  <p className="font-medium">
                    {d.person} · {phoneLabel(d.label)}
                  </p>
                  <p className="text-sm capitalize">
                    {words(d.status)} ·{" "}
                    {d.app === "van-android" ? "Van POS" : "Field app"}
                  </p>
                  <p className="text-xs text-muted">
                    {d.assessment
                      ? `${d.assessment.source === "android-self-report" ? "Android self-check (not verified)" : d.assessment.source}: ${d.assessment.rooted || d.assessment.tampered ? "integrity review needed" : "no reported concerns"}`
                      : "Integrity not assessed"}
                  </p>
                  {d.control ? (
                    <p className="text-sm">
                      {d.control.kind === "wipe" ? "Erasure" : "Handover"}:{" "}
                      {words(d.control.status)}
                      {d.control.queued_count !== null
                        ? ` · ${d.control.queued_count} queued ${d.control.queued_count === 1 ? "item" : "items"} held in recovery`
                        : " · waiting for phone contact"}
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    className={button}
                    disabled={busy}
                    onClick={() => setSelected(d)}
                  >
                    Manage phone
                  </button>
                  {d.status !== "revoked" ? (
                    <>
                      <button
                        className={button}
                        disabled={busy}
                        onClick={() => {
                          if (
                            window.confirm(
                              `Erase ${d.person}'s Sunpride data on this phone after securely holding its queued work? This does not erase other accounts.`,
                            )
                          )
                            void send("devices/wipe", {
                              deviceId: d.id,
                              reasonCode: "admin_remote_wipe",
                            });
                        }}
                      >
                        Request remote erase
                      </button>
                    </>
                  ) : null}
                  {d.control?.queued_count != null ? (
                    <button
                      className={button}
                      disabled={busy}
                      onClick={() => void exportRecovery(d.control!.id)}
                    >
                      Download held evidence
                    </button>
                  ) : null}
                  {d.handover_id && d.control?.status !== "acknowledged" ? (
                    <button
                      className={button}
                      disabled={busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            "Have you reconciled existing server records and confirmed the old phone’s unuploaded work is unrecoverable? This activates the replacement and records that decision; retained evidence is not deleted.",
                          )
                        )
                          void send("devices/complete-handover", {
                            handoverId: d.handover_id,
                            reconciliation: "lost_phone_work_unrecoverable",
                          });
                      }}
                    >
                      Complete lost-phone handover
                    </button>
                  ) : null}
                  {d.handover_id ? (
                    <button
                      className={button}
                      disabled={busy || d.control?.status !== "acknowledged"}
                      onClick={() =>
                        void send("devices/complete-handover", {
                          handoverId: d.handover_id,
                          reconciliation: "work_recovered_and_phone_erased",
                        })
                      }
                    >
                      Complete recovered handover
                    </button>
                  ) : null}
                </div>
              </article>
            ))}
            {selected ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  void send("devices/handover", {
                    deviceId: selected.id,
                    publicKeySpki: f.get("key"),
                    inventoryTag: f.get("tag"),
                    app: f.get("app"),
                    reasonCode: "replacement",
                  });
                }}
                className="grid gap-3 border-t border-border pt-4"
              >
                <h3>Replace {selected.person}&apos;s phone</h3>
                <p className="text-sm">
                  {selected.status === "revoked"
                    ? "The old registration stays retired. Use its held recovery if available; otherwise explicitly reconcile lost-phone work."
                    : "Keep the old phone online to recover its queued work and acknowledge erasure. The new phone cannot activate first."}
                </p>
                <label>
                  Replacement asset tag
                  <input name="tag" className={input} required />
                </label>
                <label>
                  Replacement public key
                  <textarea
                    name="key"
                    className={input}
                    required
                    maxLength={512}
                  />
                </label>
                <label>
                  App
                  <select name="app" className={input}>
                    <option value="field-android">Field app</option>
                    <option value="van-android">Van POS</option>
                  </select>
                </label>
                <div className="flex gap-2">
                  <button className={button} disabled={busy}>
                    Start controlled handover
                  </button>
                  <button
                    type="button"
                    className={button}
                    onClick={() => setSelected(null)}
                  >
                    Close
                  </button>
                </div>
                <button
                  type="button"
                  className={button}
                  disabled={busy}
                  onClick={() =>
                    void send("devices/exception", {
                      deviceId: selected.id,
                      reasonCode: "supervised_recovery",
                      expiresAt: Date.now() + 3600_000,
                    })
                  }
                >
                  Allow supervised integrity recovery for one hour
                </button>
              </form>
            ) : null}
            <h3 className="font-medium">Assets & peripherals</h3>
            {result.data.assets.map((a) => (
              <article
                key={a.id}
                className="border-t border-border pt-3 text-sm"
              >
                <p className="font-medium">
                  {a.asset_tag} · {a.model}
                </p>
                <p>
                  {a.assignment_needs_review
                    ? "Assignment needs review"
                    : (a.assigned_name ?? "Unassigned")}{" "}
                  · {words(a.state)} · MDM {words(a.mdm_status)} · {a.data_plan}
                </p>
                <p>
                  {a.peripherals
                    .map((p) => `${p.kind}: ${p.tag}`)
                    .join(" · ") || "No peripherals recorded"}
                </p>
                <p className="text-xs text-muted">{a.source_ref}</p>
              </article>
            ))}
          </>
        )}
      </section>
      <form className={box} onSubmit={assetForm}>
        <h2 className="font-semibold">Record an asset version</h2>
        <p className="text-sm text-muted">
          Effective now. Earlier assignment, MDM and connectivity records stay
          in history.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label>
            Asset tag
            <input name="tag" className={input} required maxLength={100} />
          </label>
          <label>
            Model
            <input name="model" className={input} required maxLength={100} />
          </label>
          <label>
            Area
            <select name="unit" className={input} required>
              <option value="">Choose area</option>
              {result.data?.units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Assigned to
            <select name="person" className={input}>
              <option value="">Spare / unassigned</option>
              {result.data?.people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            State
            <select name="state" className={input}>
              {["assigned", "spare", "repair", "retired"].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          <label>
            MDM state
            <select name="mdm" className={input}>
              {["unknown", "enrolled", "compliant", "noncompliant", "lost"].map(
                (s) => (
                  <option key={s}>{s}</option>
                ),
              )}
            </select>
          </label>
          <label>
            Data plan
            <input name="plan" className={input} required />
          </label>
          <label>
            Repair due
            <input type="date" name="due" className={input} />
          </label>
          <label>
            Printer asset tag
            <input name="printer" className={input} />
          </label>
          <label>
            Scanner asset tag
            <input name="scanner" className={input} />
          </label>
          <label>
            Source / MDM export reference
            <input name="source" className={input} required />
          </label>
          <label>
            Charging / break-fix notes
            <input name="note" className={input} />
          </label>
        </div>
        <button className={button} disabled={busy}>
          Save asset version
        </button>
      </form>
      <section className={box}>
        <h2 className="font-semibold">Import MDM register</h2>
        <p className="text-sm">
          Choose the MDM adapter&apos;s JSON array of asset versions. Import is
          all-or-nothing, up to 200 assets. Original versions stay in history.
        </p>
        <input
          type="file"
          aria-label="MDM register JSON"
          accept="application/json,.json"
          disabled={busy}
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            try {
              if (f.size > 500_000) throw Error("The import is too large.");
              const rows: unknown = JSON.parse(await f.text());
              await send("fleet/import-mdm", { rows });
            } catch {
              setMessage("Choose a valid JSON asset-version array.");
            }
          }}
        />
      </section>
      <DeviceAssessment devices={result.data?.devices ?? []} />
      <CompanyIdentity />
      <IntegrityPolicy />
    </div>
  );
}

/** F-024: review cannot clear adverse native provenance or certify imported MDM. */
export function DeviceAssessment({ devices }: { devices: Device[] }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(
    e: FormEvent<HTMLFormElement>,
    kind: "assessment" | "exception",
  ) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setMessage("");
    try {
      await mutate(
        `/api/v1/integrity/devices/${kind}`,
        kind === "assessment"
          ? {
              deviceId: f.get("deviceId"),
              source: f.get("source"),
              rooted: f.get("rooted") === "on",
              tampered: f.get("tampered") === "on",
            }
          : {
              deviceId: f.get("deviceId"),
              reasonCode: f.get("reasonCode"),
              expiresAt: Date.parse(String(f.get("expiresAt"))),
            },
        { invalidate: [["integrity"]] },
      );
      setMessage(
        kind === "assessment"
          ? "Assessment recorded. Original phone signals remain unchanged."
          : "Expiring exception recorded. The original concern stays in history.",
      );
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : "Could not record the review.",
      );
    } finally {
      setBusy(false);
    }
  }
  const phones = (
    <>
      <option value="">Choose phone</option>
      {devices.map((d) => (
        <option key={d.id} value={d.id}>
          {d.person} · {phoneLabel(d.label)}
        </option>
      ))}
    </>
  );
  return (
    <section className={box}>
      <h2 className="font-semibold">Review phone integrity</h2>
      <p className="text-sm text-muted">
        A different administrator must review the phone. Imported or manually
        entered checks are not hardware attestation; a clean office check cannot
        erase an adverse phone report.
      </p>
      <form
        className="grid gap-3"
        onSubmit={(e) => void submit(e, "assessment")}
      >
        <label>
          Phone to assess
          <select className={input} name="deviceId" required>
            {phones}
          </select>
        </label>
        <label>
          Assessment evidence reference
          <input className={input} name="source" required maxLength={150} />
        </label>
        <label>
          <input type="checkbox" name="rooted" /> Rooted device reported
        </label>
        <label>
          <input type="checkbox" name="tampered" /> Tampering reported
        </label>
        <button className={button} disabled={busy}>
          Record assessment
        </button>
      </form>
      <form
        className="grid gap-3 border-t border-border pt-4"
        onSubmit={(e) => void submit(e, "exception")}
      >
        <h3>Time-limited supervised exception</h3>
        <label>
          Phone for exception
          <select className={input} name="deviceId" required>
            {phones}
          </select>
        </label>
        <label>
          Reason
          <select className={input} name="reasonCode">
            <option value="supervised_recovery">
              Supervised evidence recovery
            </option>
            <option value="verified_false_positive">
              Reviewed false positive
            </option>
            <option value="supervised_repair">Supervised repair</option>
          </select>
        </label>
        <label>
          Expires within 24 hours
          <input
            className={input}
            name="expiresAt"
            type="datetime-local"
            required
          />
        </label>
        <button className={button} disabled={busy}>
          Approve expiring exception
        </button>
      </form>
      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}

type Policy = { settings: Record<string, number>; source_ref: string };
/** F-024/F-221/F-606: limits are editable, versioned and prospective, not app constants. */
function IntegrityPolicy() {
  const { can } = usePermissions();
  const data = useApi<Policy>(
    can("integrity.read") ? ["integrity", "policy"] : null,
    "/api/v1/integrity/policy",
  );
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  if (!data.data) return null;
  return (
    <form
      className={box}
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        setBusy(true);
        try {
          const settings = Object.fromEntries(
            Object.keys(data.data!.settings).map((k) => [k, Number(f.get(k))]),
          );
          await mutate(
            "/api/v1/integrity/policy",
            {
              settings,
              sourceRef: f.get("source"),
              effectiveFrom: Date.now() + 5000,
            },
            { invalidate: [["integrity"]] },
          );
          setMessage("Policy saved. Takes effect in five seconds.");
        } catch (e) {
          setMessage(e instanceof Error ? e.message : "Could not save policy.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2 className="font-semibold">Integrity thresholds</h2>
      <p className="text-sm text-muted">
        {data.data.source_ref}. Only national administrators can change these
        limits.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {Object.entries(data.data.settings).map(([k, v]) => (
          <label key={k} className="text-sm">
            {k.replace(/([a-z])([A-Z])/g, "$1 $2")}
            <input
              className={input}
              type="number"
              step="any"
              min={0}
              name={k}
              defaultValue={v}
              readOnly={k === "mockExitRatePct"}
              required
            />
          </label>
        ))}
        <label>
          Source / approved reason
          <input className={input} name="source" required />
        </label>
      </div>
      <button className={button} disabled={busy}>
        Schedule new limits
      </button>
      {message ? <p role="status">{message}</p> : null}
    </form>
  );
}
