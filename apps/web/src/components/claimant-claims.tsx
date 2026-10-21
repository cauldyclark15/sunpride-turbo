"use client";
import { useState, type FormEvent } from "react";
import { apiFetch, mutate, useApi } from "../lib/api";
import { manilaToday } from "../lib/outside-calls";

type Claim = {
  id: string;
  reference: string;
  type: string;
  status: string;
  amountCentavos: number;
  periodFrom: string;
  periodTo: string;
};
export type ClaimantData = {
  rows: Claim[];
  types: { id: string; code: string; required_evidence: string[] }[];
  notices: {
    id: string;
    claim_id: string;
    message: string;
    read_at: string | null;
  }[];
  sources: {
    id: string;
    kind: string;
    label: string;
    amountCentavos: number | null;
  }[];
  sourcesTruncated: boolean;
};
const panel = "grid gap-4 rounded-xl border border-border bg-surface p-5";
const field =
  "min-h-11 rounded-md border border-border bg-surface px-3 py-2 text-sm";
const money = (n: number) =>
  new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(
    n / 100,
  );
export function claimAmount(value: string) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value))
    throw new Error("Enter pesos with at most two decimal places.");
  const [whole = "", fraction = ""] = value.split(".");
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Choose a supported positive amount.");
  return Number(amount);
}
export function claimBatch(text: string, types: ClaimantData["types"]) {
  if (text.length > 64_000) throw new Error("Keep the batch under 64 KB.");
  const rows = JSON.parse(text) as Record<string, unknown>[];
  if (
    !Array.isArray(rows) ||
    !rows.length ||
    rows.length > 25 ||
    rows.some((r) => !r || typeof r !== "object" || Array.isArray(r))
  )
    throw new Error("Upload a JSON array of 1–25 claims.");
  return rows.map((r) => ({
    ...r,
    typeId: types.find((t) => t.code === r.typeCode)?.id ?? r.typeId,
    amountCentavos: claimAmount(String(r.amountPhp)),
    sources: r.sources ?? [],
  }));
}
export function ClaimantClaimList({
  data,
  onRead,
}: {
  data: ClaimantData;
  onRead?: (id: string) => void;
}) {
  return (
    <div className="grid gap-3">
      <h3 className="font-medium">Claim status & notices</h3>
      {data.notices.map((n) => (
        <article key={n.id} className="rounded-lg border border-border p-3">
          <p>{n.message}</p>
          {!n.read_at && onRead ? (
            <button className={field} onClick={() => onRead(n.id)}>
              Mark notice read
            </button>
          ) : null}
        </article>
      ))}
      {data.rows.length ? (
        data.rows.map((r) => (
          <article key={r.id} className="rounded-lg border border-border p-3">
            <p className="font-medium">
              {r.reference} · {money(r.amountCentavos)}
            </p>
            <p className="text-sm">
              {r.type} · {r.status.replaceAll("_", " ")} · {r.periodFrom} –{" "}
              {r.periodTo}
            </p>
            <p className="text-xs text-muted">
              Settlement is final only after SAP acknowledgement.
            </p>
          </article>
        ))
      ) : (
        <p className="text-sm text-muted">
          No claims submitted for this claimant.
        </p>
      )}
    </div>
  );
}
export function ClaimantClaims({
  base,
  partyId,
  name,
}: {
  base: string;
  partyId: string;
  name: string;
}) {
  const query = useApi<ClaimantData>(
    ["claimant-claims", base, partyId],
    `${base}?partyId=${encodeURIComponent(partyId)}`,
  );
  const [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [batch, setBatch] = useState("");
  async function send(action: string, body: Record<string, unknown>) {
    setBusy(true);
    setMessage("");
    try {
      const result = await mutate<{ rows?: { id: string }[] }>(
        `${base}/${action}`,
        { ...body, partyId, idempotencyKey: crypto.randomUUID() },
        { invalidate: [["claimant-claims"]] },
      );
      const fresh = await apiFetch<ClaimantData>(
        `${base}?partyId=${encodeURIComponent(partyId)}`,
      );
      if (result.rows?.some((r) => !fresh.rows.some((x) => x.id === r.id)))
        throw new Error("The submitted claim could not be read back.");
      await query.refetch();
      setMessage(
        action === "read"
          ? "Notice marked read."
          : "Submitted to Finance for independent validation. This is not a payment approval.",
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Claim could not be saved.");
    } finally {
      setBusy(false);
    }
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await send("submit", {
        reference: String(f.get("reference")),
        typeId: String(f.get("typeId")),
        periodFrom: String(f.get("from")),
        periodTo: String(f.get("to")),
        amountCentavos: claimAmount(String(f.get("amount"))),
        sources: f.getAll("sources").map((v) => {
          const [kind, sourceId] = String(v).split(":");
          return { kind, sourceId };
        }),
        ...(f.get("campaign")
          ? { campaignVersionId: String(f.get("campaign")) }
          : {}),
      });
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Check the claim fields.");
    }
  }
  if (query.error)
    return (
      <section className={panel}>
        <h2 className="text-xl font-semibold">Claims</h2>
        <p role="alert">
          Claims are unavailable for this login or its current billing grant.{" "}
          {query.error.message}
        </p>
      </section>
    );
  if (!query.data) return <section className={panel}>Loading claims…</section>;
  const data = query.data;
  return (
    <section className={panel}>
      <header>
        <h2 className="text-xl font-semibold">Claims · {name}</h2>
        <p className="text-sm text-muted">
          Submit once with original source records; follow the same Finance case
          and settlement notices here.
        </p>
      </header>
      {message ? <p role="status">{message}</p> : null}
      <ClaimantClaimList
        data={data}
        onRead={(id) => void send("read", { id })}
      />
      <form
        onSubmit={(e) => void submit(e)}
        className="grid gap-3 md:grid-cols-2"
      >
        <label className="grid gap-1 text-sm">
          Your claim reference
          <input name="reference" className={field} required maxLength={120} />
        </label>
        <label className="grid gap-1 text-sm">
          Claim type
          <select name="typeId" className={field} required>
            <option value="">Choose a governed claim type</option>
            {data.types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.code} · requires {t.required_evidence.join(", ")}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          Period from
          <input
            type="date"
            name="from"
            className={field}
            defaultValue={manilaToday()}
            required
          />
        </label>
        <label className="grid gap-1 text-sm">
          Period through
          <input
            type="date"
            name="to"
            className={field}
            defaultValue={manilaToday()}
            required
          />
        </label>
        <label className="grid gap-1 text-sm">
          Amount requested (PHP)
          <input
            name="amount"
            inputMode="decimal"
            className={field}
            required
            placeholder="0.00"
          />
        </label>
        <label className="grid gap-1 text-sm">
          Campaign version (optional)
          <input
            name="campaign"
            className={field}
            placeholder="Published campaign reference"
          />
        </label>
        <label className="grid gap-1 text-sm md:col-span-2">
          Original evidence — choose up to 20 records
          <select className={field} name="sources" multiple size={4}>
            {data.sources.map((s) => (
              <option value={`${s.kind}:${s.id}`} key={`${s.kind}:${s.id}`}>
                {s.label}
                {s.amountCentavos == null
                  ? " · value not certified"
                  : ` · ${money(s.amountCentavos)}`}
              </option>
            ))}
          </select>
        </label>
        {data.sourcesTruncated ? (
          <p className="text-sm">
            Showing the latest 100 available source records. Finance can link
            older evidence.
          </p>
        ) : null}
        <p className="text-xs text-muted md:col-span-2">
          Requested amounts are not certified by photos or uploads. Finance
          checks source quantities, value, period and duplicate usage before any
          approval.
        </p>
        <button className={field} disabled={busy || !data.types.length}>
          Submit claim for validation
        </button>
      </form>
      <details>
        <summary className="cursor-pointer text-sm font-medium">
          Bulk intake — up to 25 claims, all or none
        </summary>
        <p className="my-2 text-xs text-muted">
          Upload or paste a JSON array. Each row needs reference, typeCode,
          periodFrom, periodTo, amountPhp and sources (kind and sourceId). The
          claimant is fixed to this portal.
        </p>
        <input
          aria-label="Upload claim batch"
          type="file"
          accept="application/json,.json"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f && f.size <= 64000) void f.text().then(setBatch);
            else setMessage("Choose a JSON file under 64 KB.");
          }}
        />
        <textarea
          aria-label="Claim batch JSON"
          className={`${field} mt-3 min-h-32 w-full font-mono`}
          value={batch}
          onChange={(e) => setBatch(e.target.value)}
          placeholder='[{"reference":"YOUR-REFERENCE","typeCode":"CLAIM-TYPE","periodFrom":"YYYY-MM-DD","periodTo":"YYYY-MM-DD","amountPhp":"100.00","sources":[]}]'
        />
        <button
          className={`${field} mt-2`}
          disabled={busy || !batch}
          onClick={() => {
            try {
              void send("bulk", { rows: claimBatch(batch, data.types) });
            } catch (e) {
              setMessage(e instanceof Error ? e.message : "Check the batch.");
            }
          }}
        >
          Submit batch for validation
        </button>
      </details>
    </section>
  );
}
