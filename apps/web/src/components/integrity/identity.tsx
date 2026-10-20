"use client";
import { useState, type FormEvent } from "react";
import { mutate, useApi } from "../../lib/api";
import { usePermissions } from "../../lib/auth";

type Provider = {
  id: string;
  code: string;
  label: string;
  issuer: string;
  client_id: string;
  redirect_uri: string;
  effective_from: string;
  effective_to: string | null;
  source_ref: string;
};
type Link = {
  id: string;
  issuer: string;
  subject: string;
  person: string;
  effective_from: string;
  effective_to: string | null;
  source_ref: string;
};
type Identity = {
  providers: Provider[];
  links: Link[];
  people: Array<{ id: string; name: string }>;
  truncated: boolean;
};
const box = "grid gap-3 rounded-xl border border-border bg-surface p-5";
const input =
  "w-full rounded-lg border border-border bg-background p-2 text-sm";
const button =
  "rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-50";
/** F-007: trust configuration stays super-admin-only; no implicit email linking. */
export function CompanyIdentity() {
  const { role } = usePermissions();
  const query = useApi<Identity>(
    role === "super_admin" ? ["integrity", "identity"] : null,
    "/api/v1/integrity/identity",
  );
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  if (role !== "super_admin") return null;
  async function send(path: string, body: unknown) {
    setBusy(true);
    setMessage("");
    try {
      await mutate(`/api/v1/integrity/identity/${path}`, body, {
        invalidate: [["integrity"]],
      });
      setMessage("Saved. Earlier versions remain in history.");
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : "Could not save company sign-in.",
      );
    } finally {
      setBusy(false);
    }
  }
  function submit(e: FormEvent<HTMLFormElement>, path: string) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body = Object.fromEntries(f.entries());
    void send(path, {
      ...body,
      effectiveFrom: Date.parse(String(f.get("effectiveFrom"))),
    });
  }
  return (
    <section className={box}>
      <h2 className="font-semibold">Company sign-in</h2>
      <p className="text-sm text-muted">
        Configure the company identity provider, then explicitly link its exact
        subject to a person. Email equality never grants access. Password
        sign-in stays available.
      </p>
      {query.error ? <p role="alert">{query.error.message}</p> : null}
      {message ? <p role="status">{message}</p> : null}
      {query.data?.truncated ? (
        <p role="alert">
          History is incomplete: this view shows the first 500 entries.
        </p>
      ) : null}
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => submit(e, "provider")}
      >
        <h3 className="sm:col-span-2">Schedule a provider version</h3>
        <label>
          Provider code
          <input
            name="code"
            className={input}
            required
            pattern="[a-z][a-z0-9_]{1,79}"
          />
        </label>
        <label>
          Display name
          <input name="label" className={input} required maxLength={100} />
        </label>
        <label>
          Exact issuer URL
          <input
            name="issuer"
            type="url"
            className={input}
            required
            maxLength={500}
          />
        </label>
        <label>
          Client identifier
          <input name="clientId" className={input} required maxLength={200} />
        </label>
        <label>
          Callback URL
          <input
            name="redirectUri"
            type="url"
            className={input}
            required
            placeholder="https://your-server/api/auth/oidc/callback"
          />
        </label>
        <label>
          Effective from
          <input
            name="effectiveFrom"
            type="datetime-local"
            className={input}
            required
          />
        </label>
        <label>
          Approved source reference
          <input name="sourceRef" className={input} required maxLength={200} />
        </label>
        <button className={button} disabled={busy}>
          Save provider version
        </button>
      </form>
      <form
        className="grid gap-3 sm:grid-cols-2 border-t border-border pt-4"
        onSubmit={(e) => submit(e, "link")}
      >
        <h3 className="sm:col-span-2">Link a company identity</h3>
        <label>
          Provider issuer
          <select name="issuer" className={input} required>
            <option value="">Choose provider</option>
            {Array.from(
              new Set(query.data?.providers.map((p) => p.issuer)),
            ).map((issuer) => (
              <option key={issuer} value={issuer}>
                {issuer}
              </option>
            ))}
          </select>
        </label>
        <label>
          Exact provider subject
          <input
            name="subject"
            className={input}
            required
            maxLength={512}
            autoComplete="off"
          />
        </label>
        <label>
          Person
          <select name="profileId" className={input} required>
            <option value="">Choose person</option>
            {query.data?.people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Effective from
          <input
            name="effectiveFrom"
            type="datetime-local"
            className={input}
            required
          />
        </label>
        <label>
          Approved source reference
          <input name="sourceRef" className={input} required maxLength={200} />
        </label>
        <button className={button} disabled={busy}>
          Link exact identity
        </button>
      </form>
      <details>
        <summary>Provider and identity history</summary>
        {query.data?.providers.map((p) => (
          <article className="border-t border-border py-3 text-sm" key={p.id}>
            <p>
              {p.label} · {p.issuer}
            </p>
            <p>
              {new Date(p.effective_from).toLocaleString()} →{" "}
              {p.effective_to
                ? new Date(p.effective_to).toLocaleString()
                : "Open ended"}{" "}
              · {p.source_ref}
            </p>
          </article>
        ))}
        {query.data?.links.map((l) => (
          <article className="border-t border-border py-3 text-sm" key={l.id}>
            <p>
              {l.person} · {l.subject} · {l.issuer}
            </p>
            <p>
              {l.source_ref} · {l.effective_to ? "Retired" : "Linked"}
            </p>
            {!l.effective_to ? (
              <button
                className={button}
                disabled={busy}
                onClick={() => {
                  const reason = window.prompt(
                    "Why is this identity being retired? Existing sessions are not revoked by retiring a sign-in link.",
                  );
                  if (reason?.trim()) void send("unlink", { id: l.id, reason });
                }}
              >
                Retire identity link
              </button>
            ) : null}
          </article>
        ))}
      </details>
    </section>
  );
}
