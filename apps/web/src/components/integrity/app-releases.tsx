"use client";
import { useState } from "react";
import { usePermissions } from "../../lib/auth";
import { useApi, mutate } from "../../lib/api";

type Artifact = {
  app: string;
  packageName: string;
  versionCode: number;
  versionName: string;
  sha256: string;
  signerSha256: string;
  sizeBytes: number;
};
type Release = Artifact & {
  id: string;
  notes: string;
  effectiveFrom: number;
  withdrawn: boolean;
};
const input =
  "w-full rounded-lg border border-border bg-background p-2 text-sm";
const button =
  "rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-50";
/** F-006: one controlled channel per existing Android package; no arbitrary URL or fake signer field. */
export function AppReleases() {
  const { role } = usePermissions();
  const can = role === "super_admin";
  const query = useApi<{
    staged: Artifact[];
    releases: Release[];
    truncated: boolean;
  }>(
    can ? ["integrity", "app-releases"] : null,
    "/api/v1/integrity/app-releases",
  );
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  if (!can) return null;
  async function send(path: string, body: unknown) {
    setBusy(true);
    setMessage("");
    try {
      await mutate(`/api/v1/integrity/app-releases/${path}`, body, {
        invalidate: [["integrity", "app-releases"]],
        idempotencyKey: crypto.randomUUID(),
      });
      setMessage(
        "Release register saved. Phones check this channel from Account.",
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Release not saved");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="grid gap-3 rounded-xl border border-border bg-surface p-5"
      aria-label="Android app releases"
    >
      <h3>Android app updates</h3>
      <p className="text-sm">
        Publish an already signed APK. Phones verify its package, version, full
        content hash and the installed signing certificate before opening
        Android&apos;s installer. No silent update or clearing of queued work.
      </p>
      {query.error && <p role="alert">{query.error.message}</p>}
      {message && <p role="status">{message}</p>}
      {!query.data && !query.error && <p>Loading release register…</p>}
      {query.data && (
        <>
          {query.data.staged.length ? (
            <form
              className="grid gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                void send("publish", {
                  sha256: f.get("artifact"),
                  notes: f.get("notes"),
                  effectiveFrom: new Date(String(f.get("effective"))).getTime(),
                });
              }}
            >
              <label>
                Verified staged APK
                <select name="artifact" className={input} required>
                  <option value="">Choose signed APK</option>
                  {query.data.staged.map((a) => (
                    <option key={a.sha256} value={a.sha256}>
                      {a.app === "field-android" ? "Field" : "Van"} ·{" "}
                      {a.versionName} ·{" "}
                      {a.packageName.endsWith(".beta")
                        ? "Beta"
                        : "Non-beta build"}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Effective from
                <input
                  className={input}
                  type="datetime-local"
                  name="effective"
                  required
                />
              </label>
              <label>
                What changed
                <textarea
                  className={input}
                  name="notes"
                  required
                  maxLength={1000}
                />
              </label>
              <button className={button} disabled={busy}>
                Publish inspected update
              </button>
            </form>
          ) : (
            <p className="text-sm">
              No signed APK is staged. The release operator stages the accepted
              build on this server; signing keys stay outside the app and
              database.
            </p>
          )}
          {query.data.releases.map((r) => (
            <article
              key={r.id}
              className="grid gap-2 border-t border-border py-3 text-sm"
            >
              <p>
                {r.app === "field-android" ? "Field" : "Van"} · {r.versionName}{" "}
                · {r.withdrawn ? "Withdrawn" : "Published / scheduled"}
              </p>
              <p>{r.notes}</p>
              <p>
                Effective {new Date(r.effectiveFrom).toLocaleString("en-PH")}
              </p>
              {!r.withdrawn && (
                <button
                  className={button}
                  disabled={busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        "Withdraw this release from the update channel? Already installed apps and saved work are not removed.",
                      )
                    )
                      void send("withdraw", { id: r.id });
                  }}
                >
                  Withdraw release
                </button>
              )}
            </article>
          ))}
          {query.data.truncated && (
            <p>
              Only the latest 100 publications are shown. Earlier immutable
              publication history remains in the audit register.
            </p>
          )}
        </>
      )}
    </section>
  );
}
