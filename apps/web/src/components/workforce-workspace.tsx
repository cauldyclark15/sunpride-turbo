"use client";
import { useRef, useState } from "react";
import { apiFetch, useApi, useLive, useMutate } from "../lib/api";
import { WorkforcePolicyEditor } from "./workforce-policy-editor";
import { parseCsv } from "../lib/csv";
import { currentManilaDate } from "../lib/coverage-calendar";

type Change = {
  id: string;
  kind: string;
  status: string;
  start: number | null;
  end: number | null;
  reason: string;
  sourceRef: string;
  preparedBy: string;
  approvedBy: string | null;
  preparedId: string;
};
type Person = {
  id: string;
  name: string;
  unitName: string;
  clockIn: number | null;
  clockOut: number | null;
  firstCall: number | null;
  lastCall: number | null;
  calls: number;
  start: number | null;
  end: number | null;
  hours: number | null;
  attendance: string;
  appliedId: string | null;
  flags: string[];
  sessionId: string | null;
  changes: Change[];
};
type Day = {
  day: string;
  people: Person[];
  canApprove: boolean;
  canCorrect: boolean;
  canImport: boolean;
  actorProfileId: string;
};
type Policy = {
  id: string;
  orgUnitId: string;
  unitName: string;
  label: string;
  sourceRef: string;
  version: number;
  from: number;
  to: number | null;
  author: string;
  configuration: Configuration;
};
type Configuration = {
  fields: {
    key: string;
    label: string;
    type: string;
    required: boolean;
    maxLength: number;
    options?: string[];
  }[];
  dayStartMinutes: number;
  dayEndMinutes: number;
  maxAccuracyMeters: number;
  maxFixAgeSeconds: number;
  maxShiftHours: number;
  dedupeRadiusMeters: number;
};
type Policies = {
  policies: Policy[];
  units: { id: string; name: string }[];
  canConfigure: boolean;
};
type Prospect = {
  id: string;
  name: string;
  code: string;
  status: string;
  preparedBy: string;
  preparedId: string;
  capturedAt: number;
  answers: Record<string, string>;
  flags: string[];
  photoUrl: string;
  policy: { label: string; version: number; configuration: Configuration };
};
type Prospects = { canApprove: boolean; rows: Prospect[] };
type Review = {
  candidates: { id: string; name: string; code: string }[];
  token: string;
};
const button =
  "min-h-10 rounded-[10px] border border-border px-3 py-2 text-sm disabled:opacity-40";
const card = "rounded-xl border border-border p-4";
const time = (at: number | null) =>
  at === null
    ? "Not recorded"
    : new Intl.DateTimeFormat("en-PH", {
        timeZone: "Asia/Manila",
        dateStyle: "medium",
        timeStyle: "short",
      }).format(at);
const date = (at: number) => new Date(at + 28800000).toISOString().slice(0, 10);
const shiftDay = (day: string, n: number) =>
  new Date(Date.parse(day + "T00:00:00Z") + n * 86400000)
    .toISOString()
    .slice(0, 10);
const sample: Configuration = {
  fields: [
    {
      key: "address",
      label: "Store address",
      type: "text",
      required: true,
      maxLength: 500,
    },
    {
      key: "channel",
      label: "Proposed selling channel",
      type: "select",
      required: true,
      maxLength: 100,
      options: ["GT", "PMOT", "SM", "KAS"],
    },
    {
      key: "contactName",
      label: "Contact person",
      type: "text",
      required: true,
      maxLength: 100,
    },
    {
      key: "contactPhone",
      label: "Contact number",
      type: "text",
      required: false,
      maxLength: 40,
    },
  ],
  dayStartMinutes: 0,
  dayEndMinutes: 1440,
  maxAccuracyMeters: 250,
  maxFixAgeSeconds: 300,
  maxShiftHours: 18,
  dedupeRadiusMeters: 50,
};
/** F-222: disjoint classifications reconcile to the roster; missing evidence is not a certified absence. */
export function attendanceReading(people: Person[]) {
  const r = {
    clocked: 0,
    leave: 0,
    absence: 0,
    review: 0,
    missing: 0,
    hours: 0,
    staff: people.length,
  };
  for (const p of people) {
    if (p.attendance === "leave") r.leave++;
    else if (p.attendance === "absence") r.absence++;
    else if (p.flags.length && !p.appliedId) r.review++;
    else if (p.start !== null) r.clocked++;
    else r.missing++;
    if (p.hours !== null) r.hours += p.hours;
  }
  return { ...r, expected: r.staff - r.leave };
}
/** F-209/F-222: existing Coverage navigation, one canonical enrolment queue and attendance evidence. */
export function WorkforceWorkspace() {
  const [section, setSection] = useState("attendance"),
    [day, setDay] = useState(currentManilaDate),
    [person, setPerson] = useState(""),
    [kind, setKind] = useState("correction"),
    [start, setStart] = useState("08:00"),
    [end, setEnd] = useState("17:00"),
    [reason, setReason] = useState(""),
    [source, setSource] = useState("SAMPLE office correction / HR source"),
    [importText, setImportText] = useState("");
  const [unit, setUnit] = useState(""),
    [label, setLabel] = useState("SAMPLE field forms — not client-agreed"),
    [policySource, setPolicySource] = useState(
      "SAMPLE defaults; office to refine with Sunpride",
    ),
    [from, setFrom] = useState(shiftDay(currentManilaDate(), 1)),
    [configuration, setConfiguration] = useState(
      JSON.stringify(sample, null, 2),
    );
  const [reviewId, setReviewId] = useState(""),
    [review, setReview] = useState<Review | null>(null),
    [existing, setExisting] = useState(""),
    [decisionReason, setDecisionReason] = useState(""),
    [distinct, setDistinct] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const today = useApi<Day>(
      ["coverage", "workforce", "day", day],
      `/api/v1/coverage/workforce/day?day=${day}`,
    ),
    prior = useApi<Day>(
      ["coverage", "workforce", "day", shiftDay(day, -1)],
      `/api/v1/coverage/workforce/day?day=${shiftDay(day, -1)}`,
    ),
    policies = useApi<Policies>(
      ["coverage", "workforce", "policies"],
      "/api/v1/coverage/workforce/policies",
    ),
    prospects = useApi<Prospects>(
      ["coverage", "workforce", "prospects"],
      "/api/v1/coverage/workforce/prospects",
    );
  useLive(["coverage"], [["coverage"]]);
  const { mutate } = useMutate();
  const keys = useRef(new Map<string, string>());
  async function send(path: string, body: object, message: string) {
    const intent = JSON.stringify({ path, body });
    let key = keys.current.get(intent);
    if (!key) {
      key = crypto.randomUUID();
      keys.current.set(intent, key);
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await mutate(
        `/api/v1/coverage/workforce/${path}`,
        { ...body, idempotencyKey: key },
        { invalidate: [["coverage"]] },
      );
      keys.current.delete(intent);
      setNotice(message);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not save this field record",
      );
    } finally {
      setBusy(false);
    }
  }
  async function openReview(id: string) {
    setError("");
    setBusy(true);
    try {
      setReview(
        await apiFetch<Review>(`/api/v1/coverage/workforce/prospects/${id}`),
      );
      setReviewId(id);
      setExisting("");
      setDistinct(false);
      setDecisionReason("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load master review");
    } finally {
      setBusy(false);
    }
  }
  const data = today.data,
    prev = prior.data;
  if (today.error || prior.error || policies.error || prospects.error)
    return (
      <p role="alert">
        {
          (today.error ?? prior.error ?? policies.error ?? prospects.error)
            ?.message
        }
      </p>
    );
  if (!data || !prev || !policies.data || !prospects.data)
    return <p>Loading workforce evidence…</p>;
  const read = attendanceReading(data.people),
    before = attendanceReading(prev.people),
    selected = data.people.find((p) => p.id === person),
    selectedProspect = prospects.data.rows.find((p) => p.id === reviewId);
  return (
    <div className="grid gap-5">
      <header>
        <h2 className="text-lg font-medium">
          Who is in the field, and what needs office review?
        </h2>
        <p className="text-sm text-muted">
          Original clock evidence stays intact. Corrections and HR imports need
          a different approver. Attendance never starts or stops consented
          location sharing.
        </p>
      </header>
      <nav aria-label="Workforce views" className="flex flex-wrap gap-2">
        {(
          [
            ["attendance", "Attendance"],
            ["prospects", "Prospect review"],
            ["policy", "Field form policies"],
          ] as const
        ).map(([id, name]) => (
          <button
            key={id}
            className={button}
            aria-pressed={section === id}
            onClick={() => setSection(id)}
          >
            {name}
          </button>
        ))}
      </nav>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {section === "attendance" && (
        <>
          <label className="grid gap-1 text-sm">
            Manila attendance day
            <input
              type="date"
              value={day}
              onChange={(e) => {
                if (e.target.value) setDay(e.target.value);
              }}
            />
          </label>
          <section
            aria-label="Attendance comparison"
            className="grid gap-3 md:grid-cols-4"
          >
            {[
              [
                "Clocked staff",
                `${read.clocked} / ${read.expected} roster target`,
                `Prior day: ${before.clocked} / ${before.expected}`,
              ],
              [
                "Needs evidence review",
                String(read.review),
                `Prior day: ${before.review}`,
              ],
              [
                "Leave / absence",
                `${read.leave} / ${read.absence}`,
                `Prior day: ${before.leave} / ${before.absence}`,
              ],
              [
                "Closed-clock span",
                `${read.hours.toFixed(2)} hours`,
                `Prior day: ${before.hours.toFixed(2)} hours`,
              ],
            ].map(([name, value, note]) => (
              <article key={name} className={card}>
                <p className="text-sm text-muted">{name}</p>
                <p className="text-xl font-medium">{value}</p>
                <p className="text-xs text-muted">{note}</p>
              </article>
            ))}
          </section>
          <p className="text-sm">
            Daily reading: {before.clocked} → {read.clocked} clocked staff.{" "}
            {read.missing} have no recorded clock-in here; verify before
            treating that as absence. The provisional target is one record per
            roster person except approved leave. Elapsed closed-clock span is
            not continuous-location proof or payroll.
          </p>
          <section aria-label="Attendance evidence" className="grid gap-3">
            {[...data.people]
              .sort(
                (a, b) => Number(a.start !== null) - Number(b.start !== null),
              )
              .map((p) => (
                <article className={card} key={p.id}>
                  <h3 className="font-medium">
                    {p.name} · {p.unitName}
                  </h3>
                  <p className="text-sm">
                    {p.attendance === "leave"
                      ? "Approved leave"
                      : p.attendance === "absence"
                        ? "Approved absence"
                        : p.start === null
                          ? "No clock-in recorded here"
                          : "Clocked"}{" "}
                    ·{" "}
                    {p.hours === null
                      ? "Clock span not closed"
                      : `${p.hours.toFixed(2)} hours`}
                  </p>
                  <dl className="grid gap-1 text-sm sm:grid-cols-2">
                    <div>Raw clock-in: {time(p.clockIn)}</div>
                    <div>Raw clock-out: {time(p.clockOut)}</div>
                    <div>First call arrival: {time(p.firstCall)}</div>
                    <div>Last call end: {time(p.lastCall)}</div>
                  </dl>
                  <p className="text-sm">
                    {p.calls} calls ·{" "}
                    {p.flags.length
                      ? p.flags.map((x) => x.replaceAll("_", " ")).join(", ")
                      : "No capture flags"}
                  </p>
                  {p.sessionId &&
                    (data.canApprove || p.id === data.actorProfileId) && (
                      <a
                        className="text-sm underline"
                        target="_blank"
                        rel="noreferrer"
                        href={`/api/v1/coverage/workforce/photo/attendance/${p.sessionId}`}
                      >
                        View private clock-in photo
                      </a>
                    )}
                  {data.canCorrect && (
                    <div className="mt-2">
                      <button
                        className={button}
                        onClick={() => {
                          setPerson(p.id);
                          setReason("");
                        }}
                      >
                        Request correction or record HR evidence
                      </button>
                    </div>
                  )}
                  {p.changes.map((c) => (
                    <div
                      className="mt-3 border-t border-border pt-3 text-sm"
                      key={c.id}
                    >
                      <p>
                        {c.kind} · {c.status} · prepared by {c.preparedBy}
                        {c.approvedBy ? ` · decided by ${c.approvedBy}` : ""}
                      </p>
                      <p>
                        {c.reason} · {c.sourceRef}
                      </p>
                      <p>
                        {time(c.start)} → {time(c.end)}
                      </p>
                      {data.canApprove &&
                        c.status === "pending" &&
                        c.preparedId !== data.actorProfileId &&
                        p.id !== data.actorProfileId && (
                          <div className="mt-2 flex gap-2">
                            <button
                              disabled={busy}
                              className={button}
                              onClick={() =>
                                send(
                                  "corrections/decide",
                                  {
                                    id: c.id,
                                    decision: "approved",
                                    reason:
                                      "Office reviewed original and proposed attendance evidence",
                                  },
                                  "Attendance change approved; original capture retained.",
                                )
                              }
                            >
                              Approve change
                            </button>
                            <button
                              disabled={busy}
                              className={button}
                              onClick={() =>
                                send(
                                  "corrections/decide",
                                  {
                                    id: c.id,
                                    decision: "rejected",
                                    reason:
                                      "Office declined this requested attendance change",
                                  },
                                  "Change rejected; original capture retained.",
                                )
                              }
                            >
                              Reject change
                            </button>
                          </div>
                        )}
                    </div>
                  ))}
                </article>
              ))}
          </section>
          {data.canCorrect && (
            <form
              aria-label="Request attendance correction"
              className={card + " grid gap-3"}
              onSubmit={(e) => {
                e.preventDefault();
                send(
                  "corrections",
                  {
                    profileId: person,
                    day,
                    kind,
                    start:
                      kind === "correction"
                        ? Date.parse(`${day}T${start}:00+08:00`)
                        : null,
                    end:
                      kind === "correction"
                        ? Date.parse(`${day}T${end}:00+08:00`)
                        : null,
                    reason,
                    sourceRef: source,
                    replacesId: selected?.appliedId ?? null,
                  },
                  "Request saved. A different approver must decide it.",
                );
              }}
            >
              <h3 className="font-medium">
                Request a correction, absence or leave
              </h3>
              <label className="grid gap-1 text-sm">
                Employee
                <select
                  required
                  value={person}
                  onChange={(e) => setPerson(e.target.value)}
                >
                  <option value="">Choose employee</option>
                  {data.people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · {p.unitName}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-sm">
                Record type
                <select value={kind} onChange={(e) => setKind(e.target.value)}>
                  <option value="correction">Clock-time correction</option>
                  <option value="absence">Absence evidence</option>
                  <option value="leave">Leave evidence</option>
                </select>
              </label>
              {kind === "correction" && (
                <div className="grid gap-2 sm:grid-cols-2">
                  <label>
                    Proposed start
                    <input
                      type="time"
                      required
                      value={start}
                      onChange={(e) => setStart(e.target.value)}
                    />
                  </label>
                  <label>
                    Proposed end
                    <input
                      type="time"
                      required
                      value={end}
                      onChange={(e) => setEnd(e.target.value)}
                    />
                  </label>
                </div>
              )}
              <label>
                Reason
                <textarea
                  required
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
              <label>
                Source or HR reference
                <input
                  required
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                />
              </label>
              <button className={button} disabled={busy}>
                Save for independent approval
              </button>
            </form>
          )}
          {data.canImport && (
            <form
              aria-label="Absence and leave adapter"
              className={card + " grid gap-3"}
              onSubmit={(e) => {
                e.preventDefault();
                try {
                  const parsed = parseCsv(importText, [
                    "employeeCode",
                    "day",
                    "kind",
                    "reason",
                    "externalKey",
                  ]);
                  if (parsed.errors.length) throw new Error("CSV format");
                  send(
                    "absence-import",
                    {
                      sourceRef: source,
                      rows: parsed.rows.map((r) => r.values),
                    },
                    "HR source rows staged for independent approval.",
                  );
                } catch {
                  setError(
                    "Use the exact CSV header and one employee-code row per absence or leave record.",
                  );
                }
              }}
            >
              <h3 className="font-medium">Absence / leave import adapter</h3>
              <p className="text-sm text-muted">
                CSV, up to 100 rows. Employee codes resolve only within your
                current authorized workforce; leading zeroes are kept. Kinds are
                absence or leave. Re-importing a source row is idempotent.
                Nothing updates payroll or approves itself.
              </p>
              <label>
                HR source reference
                <input
                  required
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                />
              </label>
              <label>
                HR rows CSV
                <textarea
                  required
                  rows={5}
                  value={importText}
                  onChange={(e) => setImportText(e.target.value)}
                  placeholder="employeeCode,day,kind,reason,externalKey"
                />
              </label>
              <button className={button} disabled={busy}>
                Stage HR rows
              </button>
            </form>
          )}
        </>
      )}
      {section === "prospects" && (
        <section
          aria-label="Prospect acquisition review"
          className="grid gap-3"
        >
          <h3 className="font-medium">
            Approve a distinct store, or link an existing master
          </h3>
          <p className="text-sm text-muted">
            The local MASTERS adapter checks exact names and nearby verified
            pins. It does not silently merge or overwrite any master; governed
            cross-key dedupe is an integration seam.
          </p>
          {prospects.data.rows.length === 0 && (
            <p>No captured prospects in your current scope.</p>
          )}
          {prospects.data.rows.map((p) => (
            <article className={card} key={p.id}>
              <h4 className="font-medium">
                {p.name} · {p.code}
              </h4>
              <p className="text-sm">
                {p.status.replaceAll("_", " ")} · captured by {p.preparedBy} ·{" "}
                {time(p.capturedAt)}
              </p>
              <p className="text-sm">
                {p.policy.label} · version {p.policy.version}
              </p>
              <dl className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
                {p.policy.configuration.fields.map((f) => (
                  <div key={f.key}>
                    <dt className="text-muted">{f.label}</dt>
                    <dd>{p.answers[f.key] || "Not supplied"}</dd>
                  </div>
                ))}
              </dl>
              <p className="text-sm">
                {p.flags.length
                  ? p.flags.map((x) => x.replaceAll("_", " ")).join(", ")
                  : "Location and photo captured"}
              </p>
              {(prospects.data!.canApprove ||
                p.preparedId === data.actorProfileId) && (
                <a
                  href={p.photoUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm underline"
                >
                  View private storefront photo
                </a>
              )}
              {prospects.data!.canApprove &&
                p.status === "pending" &&
                p.preparedId !== data.actorProfileId && (
                  <div className="mt-3">
                    <button
                      className={button}
                      disabled={busy}
                      onClick={() => openReview(p.id)}
                    >
                      Review master candidates
                    </button>
                  </div>
                )}
            </article>
          ))}
          {review &&
            selectedProspect &&
            selectedProspect.status === "pending" && (
              <section
                className={card + " grid gap-3"}
                aria-label="Master dedupe decision"
              >
                <h4 className="font-medium">Review {selectedProspect.name}</h4>
                <p className="text-sm">
                  {review.candidates.length} scoped candidate(s). Recheck
                  storefront, location and KYC before deciding.
                </p>
                <label>
                  Existing master
                  <select
                    value={existing}
                    onChange={(e) => setExisting(e.target.value)}
                  >
                    <option value="">No existing master selected</option>
                    {review.candidates.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} · {p.code}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={distinct}
                    onChange={(e) => setDistinct(e.target.checked)}
                  />
                  I reviewed the candidates and this is a distinct store
                </label>
                <label>
                  Review reason
                  <textarea
                    value={decisionReason}
                    onChange={(e) => setDecisionReason(e.target.value)}
                  />
                </label>
                <div className="flex flex-wrap gap-2">
                  {(
                    [
                      ["approve_distinct", "Approve distinct store"],
                      ["link_existing", "Link existing master"],
                      ["reject", "Reject proposal"],
                    ] as const
                  ).map(([decision, title]) => (
                    <button
                      key={decision}
                      className={button}
                      disabled={
                        busy ||
                        !decisionReason ||
                        (decision === "link_existing" && !existing) ||
                        (decision === "approve_distinct" &&
                          review.candidates.length > 0 &&
                          !distinct)
                      }
                      onClick={() =>
                        send(
                          "prospects/decide",
                          {
                            id: reviewId,
                            decision,
                            dedupeToken: review.token,
                            existingOutletId: existing || null,
                            confirmDistinct: distinct,
                            reason: decisionReason,
                          },
                          "Master review recorded. Approved distinct stores are available for territory assignment and a new PJP version.",
                        )
                      }
                    >
                      {title}
                    </button>
                  ))}
                </div>
              </section>
            )}
        </section>
      )}
      {section === "policy" && (
        <section className="grid gap-3" aria-label="Field form policy versions">
          <h3 className="font-medium">
            Effective KYC and attendance capture rules
          </h3>
          <p className="text-sm text-muted">
            These are non-call capture windows. Visit day-close and consented
            tracking remain separate. Changes are immutable and prospective;
            sample defaults are not Sunpride agreement.
          </p>
          {policies.data.canConfigure && (
            <form
              aria-label="Configure field forms"
              className={card + " grid gap-3"}
              onSubmit={(e) => {
                e.preventDefault();
                try {
                  send(
                    "policies",
                    {
                      orgUnitId: unit,
                      label,
                      sourceRef: policySource,
                      fromDate: from,
                      configuration: JSON.parse(configuration),
                    },
                    "Effective field form policy saved.",
                  );
                } catch {
                  setError("Check the policy JSON.");
                }
              }}
            >
              <label>
                Team
                <select
                  required
                  value={unit}
                  onChange={(e) => {
                    const id = e.target.value;
                    setUnit(id);
                    const latest = policies.data!.policies.find(
                      (p) => p.orgUnitId === id,
                    );
                    setFrom(shiftDay(currentManilaDate(), latest ? 1 : 0));
                    if (latest) {
                      setConfiguration(
                        JSON.stringify(latest.configuration, null, 2),
                      );
                      setLabel(latest.label);
                      setPolicySource(latest.sourceRef);
                    }
                  }}
                >
                  <option value="">Choose team</option>
                  {policies.data.units.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Policy label
                <input
                  required
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                />
              </label>
              <label>
                Source / assumption
                <input
                  required
                  value={policySource}
                  onChange={(e) => setPolicySource(e.target.value)}
                />
              </label>
              <label>
                Effective Manila day
                <input
                  required
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </label>
              <WorkforcePolicyEditor
                value={configuration}
                onChange={setConfiguration}
              />
              <p className="text-xs text-muted">
                Fields may be text or select. Address, proposed channel and
                contact person stay required for canonical master review. Day
                minutes, freshness, accuracy review, shift-span and dedupe
                candidate tolerances are editable here.
              </p>
              <button className={button} disabled={busy}>
                Save effective policy
              </button>
            </form>
          )}
          {policies.data.policies.map((p) => (
            <article className={card} key={p.id}>
              <h4 className="font-medium">
                {p.label} · version {p.version}
              </h4>
              <p className="text-sm">
                {p.unitName} · {date(p.from)} to{" "}
                {p.to === null ? "open-ended" : date(p.to)} · prepared by{" "}
                {p.author}
              </p>
              <p className="text-sm">{p.sourceRef}</p>
              <p className="text-sm">
                KYC:{" "}
                {p.configuration.fields
                  .map((f) => f.label + (f.required ? " (required)" : ""))
                  .join(", ")}
              </p>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
