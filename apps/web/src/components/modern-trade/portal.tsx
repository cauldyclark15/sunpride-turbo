"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useApi } from "../../lib/api";
import { useSession } from "../../lib/auth/session";
import type { PortalOverview } from "./model";
import {
  Field,
  Form,
  Notice,
  action,
  dateText,
  inputClass,
  label,
  panel,
  php,
  text,
  useCommand,
} from "./kit";

export function CustomerPortal() {
  const query = useApi<PortalOverview>(
    ["portal", "overview"],
    "/api/v1/portal/overview",
  );
  const { refetch } = query;
  useEffect(() => {
    const timer = setInterval(() => void refetch(), 30000);
    return () => clearInterval(timer);
  }, [refetch]);
  const cmd = useCommand(),
    session = useSession(),
    router = useRouter();
  // A refusal never displays retained data from a previously authorized request.
  if (query.error)
    return (
      <Notice>
        {query.error.message}{" "}
        <Link href="/portal/login" className="underline">
          Return to customer sign in
        </Link>
      </Notice>
    );
  if (!query.data) return <Notice>Loading your account…</Notice>;
  const data = query.data;
  return (
    <main className="mx-auto grid w-full max-w-5xl gap-8 px-4 py-8 md:px-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-widest text-muted">
            Sunpride · Customer portal
          </p>
          <h1 className="mt-2 text-2xl font-semibold">Your orders & account</h1>
        </div>
        <button
          className={action}
          onClick={() =>
            void session.signOut().then(() => {
              router.replace("/portal/login");
              router.refresh();
            })
          }
        >
          Sign out
        </button>
      </header>
      <section>
        <h2 className="mb-4 text-lg font-semibold">
          Purchase orders · receipt to delivery
        </h2>
        <div className="grid gap-4">
          {data.purchaseOrders.map((p) => (
            <article className={panel} key={p.id}>
              <div className="flex flex-wrap justify-between gap-2">
                <div>
                  <h3 className="font-semibold">{p.poNumber}</h3>
                  <p className="text-sm text-muted">
                    {p.branch} · {p.orderNumber ?? "Awaiting confirmation"} ·{" "}
                    {label(p.status)}
                  </p>
                </div>
                <p>{php(p.amountCentavos)}</p>
              </div>
              <ol className="mt-4 flex flex-wrap gap-3 text-sm">
                {p.milestones.map((m, i) => (
                  <li key={i} className="rounded-lg border border-border p-2">
                    {label(m.stage)}
                    <span className="mt-1 block text-xs text-muted">
                      {dateText(m.at)}
                    </span>
                  </li>
                ))}
              </ol>
              <p className="mt-3 text-xs text-muted">{p.deliverySource}</p>
            </article>
          ))}
        </div>
        {!data.purchaseOrders.length ? (
          <Notice>
            No purchase orders have been received for this account.
          </Notice>
        ) : null}
      </section>
      <section>
        <h2 className="mb-4 text-lg font-semibold">Invoices</h2>
        <div className="grid gap-3">
          {data.invoices.map((i) => (
            <article className={panel} key={i.id}>
              <div className="flex justify-between gap-3">
                <h3 className="font-semibold">{i.invoiceNumber}</h3>
                <p>{php(i.amountCentavos)}</p>
              </div>
              <p className="mt-2 text-sm text-muted">
                {i.branch} · Issued {dateText(i.issuedOn)} · Due{" "}
                {dateText(i.dueOn)} ·{" "}
                {i.source === "sample"
                  ? "Sample SAP invoice"
                  : "SAP invoice replica"}
              </p>
            </article>
          ))}
        </div>
        {!data.invoices.length ? (
          <Notice>
            No invoice feed received for this account. This is not a statement
            of zero balance.
          </Notice>
        ) : null}
      </section>
      <section>
        <h2 className="mb-4 text-lg font-semibold">Deductions & disputes</h2>
        {cmd.error ? <Notice>{cmd.error}</Notice> : null}
        <div className="grid gap-4">
          {data.deductions.map((d) => (
            <article className={panel} key={d.id}>
              <div className="flex justify-between gap-3">
                <div>
                  <h3 className="font-semibold">
                    {d.type} · {d.reference}
                  </h3>
                  <p className="text-sm text-muted">
                    {d.branch} · {label(d.status)} · {d.ageDays} days old
                  </p>
                </div>
                <p>{php(d.amountCentavos)}</p>
              </div>
              <p className="mt-2 text-sm text-muted">
                {d.invoiceNumber ?? "Invoice not linked"} · Follow-up due{" "}
                {dateText(d.dueOn)}
              </p>
              {d.disputes.some((s) => s.status === "accepted") ? (
                <p className="mt-3 text-sm">
                  Dispute accepted. Awaiting SAP settlement review; this is not
                  a credit memo.
                </p>
              ) : null}
              {d.disputes.map((s) => (
                <div
                  className="mt-4 border-t border-border pt-3 text-sm"
                  key={s.id}
                >
                  <p className="font-medium">
                    {s.reference} · {label(s.status)}
                  </p>
                  <p>{s.message}</p>
                  {s.response ? (
                    <p className="mt-2">Account team: {s.response}</p>
                  ) : null}
                </div>
              ))}
              {d.status !== "resolved" &&
              !d.disputes.some((s) =>
                ["open", "accepted"].includes(s.status),
              ) ? (
                <details className="mt-4">
                  <summary className="cursor-pointer text-sm underline">
                    Dispute this deduction
                  </summary>
                  <div className="mt-4">
                    <Form
                      onSubmit={async (f) => {
                        await cmd.run("/api/v1/portal/disputes/submit", {
                          deductionId: d.id,
                          reference: text(f, "reference"),
                          message: text(f, "message"),
                        });
                      }}
                    >
                      <Field label="Your dispute reference">
                        <input
                          name="reference"
                          className={inputClass}
                          required
                          maxLength={160}
                        />
                      </Field>
                      <Field label="Why should this deduction be reviewed?">
                        <textarea
                          name="message"
                          className={inputClass}
                          required
                          maxLength={2000}
                        />
                      </Field>
                      <button className={action} disabled={cmd.pending}>
                        Submit dispute
                      </button>
                    </Form>
                  </div>
                </details>
              ) : null}
            </article>
          ))}
        </div>
        {!data.deductions.length ? (
          <Notice>No deductions have been recorded for your account.</Notice>
        ) : null}
      </section>
    </main>
  );
}
export function PortalLogin() {
  const session = useSession(),
    router = useRouter(),
    [error, setError] = useState(""),
    [pending, setPending] = useState(false);
  return (
    <main className="mx-auto grid min-h-dvh max-w-md content-center gap-6 px-6 py-10">
      <div>
        <p className="text-xs uppercase tracking-widest text-muted">
          Sunpride · Customer portal
        </p>
        <h1 className="mt-3 text-3xl font-semibold">Welcome back</h1>
        <p className="mt-2 text-sm text-muted">
          Track your purchase orders, invoices and deduction disputes.
        </p>
      </div>
      {error ? <Notice>{error}</Notice> : null}
      <Form
        onSubmit={async (f) => {
          setPending(true);
          setError("");
          try {
            const result = await session.signIn({
              email: text(f, "email"),
              password: String(f.get("password") ?? ""),
            });
            if (result.error) throw result.error;
            router.replace("/portal");
            router.refresh();
          } catch (e) {
            setError(e instanceof Error ? e.message : "Sign in failed");
          } finally {
            setPending(false);
          }
        }}
      >
        <Field label="Email">
          <input
            name="email"
            type="email"
            autoComplete="username"
            required
            className={inputClass}
          />
        </Field>
        <Field label="Password">
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className={inputClass}
          />
        </Field>
        <button
          className={`${action} bg-foreground text-background`}
          disabled={pending}
        >
          {pending ? "Signing in…" : "Sign in to your account"}
        </button>
      </Form>
      <Link className="text-sm text-muted underline" href="/login">
        Sunpride employee sign in
      </Link>
    </main>
  );
}
