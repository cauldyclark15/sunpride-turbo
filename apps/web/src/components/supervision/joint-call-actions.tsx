"use client";
import { useState } from "react";
import type { EndpointResult } from "./report-api";
import { useReportCommand } from "./report-api";
import type { JointCallAction } from "./report-dto";

type Detail = EndpointResult<"supervision.work_with.detail">;
type Draft = { agreement: string; owner: "trainee" | "trainer"; dueOn: string };

const button =
  "min-h-10 rounded-[10px] border border-border px-3 py-2 text-sm disabled:opacity-40";
const OWNER = { trainee: "Trainee", trainer: "Trainer" } as const;
const OUTCOME = {
  open: "To review",
  done: "Done",
  not_done: "Not done",
} as const;

/** F-223: the follow-up line shown for each carried agreement. */
export function carriedLine(a: JointCallAction, today: string) {
  const late = a.status === "open" && a.dueOn < today;
  return `${a.agreement} — ${OWNER[a.owner].toLowerCase()} to do by ${a.dueOn}${late ? " (overdue)" : ""}; agreed ${a.agreedOn}`;
}

/** F-223: agreed actions at this joint call, and review of the last joint call's agreements. */
export function JointCallActions({
  detail,
  today,
}: {
  detail: Detail;
  today: string;
}) {
  const save = useReportCommand("supervision.work_with.actions.save");
  const review = useReportCommand("supervision.work_with.actions.review");
  const state = detail.jointCall ?? { agreed: [], carried: [] };
  const sessionId = detail.session._id;
  const editable = detail.canEdit;
  const [drafts, setDrafts] = useState<Draft[]>(() =>
    state.agreed.map((a) => ({
      agreement: a.agreement,
      owner: a.owner,
      dueOn: a.dueOn,
    })),
  );
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  async function run(fn: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      setNotice(message);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }
  const open = state.carried.filter((a) => a.status === "open");
  return (
    <section
      aria-label="Joint call follow-up"
      className="grid gap-4 rounded-xl border border-border p-4"
    >
      <header>
        <h3 className="font-medium">
          Did the last joint call&apos;s agreements happen?
        </h3>
        <p className="text-sm text-muted">
          {open.length
            ? `${open.length} agreed action${open.length === 1 ? "" : "s"} from the last joint call ${open.length === 1 ? "needs" : "need"} review before this one can be completed.`
            : state.carried.length
              ? "Every earlier agreement is reviewed."
              : "No earlier agreements with this trainee."}
        </p>
      </header>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {state.carried.length > 0 && (
        <ul className="grid gap-3" aria-label="Agreements to review">
          {[...open, ...state.carried.filter((a) => a.status !== "open")].map(
            (a) => (
              <li
                key={a.id}
                className="grid gap-2 rounded-lg border border-border p-3"
              >
                <p className="text-sm">
                  <span className="font-medium">{OUTCOME[a.status]}:</span>{" "}
                  {carriedLine(a, today)}
                </p>
                {a.status !== "open" ? (
                  <p className="text-sm text-muted">
                    Seen at this joint call: {a.reviewNote}
                  </p>
                ) : editable ? (
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="grid flex-1 gap-1 text-sm">
                      What you saw (needed to mark it)
                      <input
                        value={notes[a.id] ?? ""}
                        onChange={(e) =>
                          setNotes({ ...notes, [a.id]: e.target.value })
                        }
                      />
                    </label>
                    {(["done", "not_done"] as const).map((outcome) => (
                      <button
                        key={outcome}
                        className={button}
                        disabled={busy || !(notes[a.id] ?? "").trim()}
                        onClick={() =>
                          run(
                            () =>
                              review({
                                sessionId,
                                actionId: a.id,
                                outcome,
                                note: (notes[a.id] ?? "").trim(),
                              }),
                            "Review saved.",
                          )
                        }
                      >
                        {OUTCOME[outcome]}
                      </button>
                    ))}
                  </div>
                ) : null}
              </li>
            ),
          )}
        </ul>
      )}
      <section aria-label="Agreed actions" className="grid gap-2">
        <h4 className="text-sm font-medium">Agreed at this joint call</h4>
        {drafts.length === 0 && !editable && (
          <p className="text-sm">No actions agreed.</p>
        )}
        {drafts.map((d, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[1fr_auto_auto_auto]">
            <label className="grid gap-1 text-sm">
              Agreed action
              <input
                disabled={!editable}
                value={d.agreement}
                onChange={(e) =>
                  setDrafts(
                    drafts.map((x, j) =>
                      j === i ? { ...x, agreement: e.target.value } : x,
                    ),
                  )
                }
              />
            </label>
            <label className="grid gap-1 text-sm">
              Who
              <select
                disabled={!editable}
                value={d.owner}
                onChange={(e) =>
                  setDrafts(
                    drafts.map((x, j) =>
                      j === i
                        ? { ...x, owner: e.target.value as Draft["owner"] }
                        : x,
                    ),
                  )
                }
              >
                <option value="trainee">Trainee</option>
                <option value="trainer">Trainer</option>
              </select>
            </label>
            <label className="grid gap-1 text-sm">
              By
              <input
                type="date"
                disabled={!editable}
                min={detail.session.serviceDate}
                value={d.dueOn}
                onChange={(e) =>
                  setDrafts(
                    drafts.map((x, j) =>
                      j === i ? { ...x, dueOn: e.target.value } : x,
                    ),
                  )
                }
              />
            </label>
            {editable && (
              <button
                className={button + " self-end"}
                onClick={() => setDrafts(drafts.filter((_, j) => j !== i))}
              >
                Remove
              </button>
            )}
          </div>
        ))}
        {editable && (
          <div className="flex flex-wrap gap-2">
            <button
              className={button}
              disabled={drafts.length >= 10}
              onClick={() =>
                setDrafts([
                  ...drafts,
                  {
                    agreement: "",
                    owner: "trainee",
                    dueOn: detail.session.serviceDate,
                  },
                ])
              }
            >
              Add agreed action
            </button>
            <button
              className={button}
              disabled={busy || drafts.some((d) => !d.agreement.trim())}
              onClick={() =>
                run(
                  () =>
                    save({
                      sessionId,
                      actions: drafts.map((d) => ({
                        ...d,
                        agreement: d.agreement.trim(),
                      })),
                    }),
                  "Agreed actions saved. They open the next joint call with this trainee.",
                )
              }
            >
              Save agreed actions
            </button>
          </div>
        )}
      </section>
    </section>
  );
}
