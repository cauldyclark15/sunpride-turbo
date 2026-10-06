import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";

const PAGES_TO_TEST: readonly (readonly [string, string])[] = [
  ["Home", "Today's totals: products, customers, low stock, open orders."],
  [
    "Commercial",
    "Orders, outside-call purchase orders, master data (products and customers) and imports.",
  ],
  [
    "Inventory",
    "Stock by location, receiving, transfers, stock counts, adjustments and movements.",
  ],
  [
    "Field",
    "Coverage plans, supervision, call sheets, the daily sales report, training and DAR / ROAR.",
  ],
  ["Approvals", "Orders waiting for your decision."],
  [
    "Reports",
    "Execution, territory performance, coverage, exceptions and SKU distribution.",
  ],
  [
    "Admin",
    "For administrators: people, teams, invitations, territories, routes, outlets and phones.",
  ],
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-2 border-t border-separator pt-5">
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      <div className="grid gap-2 text-sm leading-6 text-muted">{children}</div>
    </section>
  );
}

/**
 * Beta release (SP-0123): one-page guide for Sunpride's testers. `apkUrl` comes from
 * `NEXT_PUBLIC_BETA_APK_URL`; the download section is hidden when it is empty.
 */
export function TesterGuide({ apkUrl }: { apkUrl: string | null }) {
  return (
    <main className="min-h-screen bg-background p-5">
      <article className="mx-auto grid w-full max-w-[720px] gap-5 rounded-2xl border border-border bg-surface p-6 sm:p-8">
        <header className="flex items-center gap-3">
          <Image
            src="/sunpride-logo.jpg"
            alt="Sunpride"
            width={40}
            height={40}
            className="rounded-[7px]"
          />
          <div>
            <h1 className="text-[22px] font-semibold tracking-tight text-foreground">
              Getting started for testers
            </h1>
            <p className="text-[13px] text-muted">Sunpride Operations · Beta</p>
          </div>
        </header>
        <p className="text-sm leading-6 text-muted">
          Thank you for testing. This is an early version: some parts are still
          being built and are hidden for now. Use it the way you would on a
          normal working day and tell us whatever is wrong, unclear or missing.
        </p>

        <Section title="1. Sign in">
          <p>
            Your administrator invites you by email address. The first time,
            open the sign-in page, choose <strong>Create account</strong> and
            use that same email address with a password of at least 8
            characters. After that, just sign in.
          </p>
          <p>
            If you see &ldquo;You have not been assigned to an area yet&rdquo;,
            you are signed in correctly; ask your administrator to assign you to
            your area. If you see that your email has not been invited, sign out
            and ask your administrator.
          </p>
        </Section>

        <Section title="2. What to test">
          <ul className="grid gap-1.5">
            {PAGES_TO_TEST.map(([page, detail]) => (
              <li key={page}>
                <strong className="text-foreground">{page}</strong> — {detail}
              </li>
            ))}
          </ul>
          <p>
            You only see the pages your role allows. The link to SAP is not part
            of this test.
          </p>
        </Section>

        <Section title="3. Report an issue">
          <ol className="grid list-decimal gap-1.5 pl-5">
            <li>
              On the page where something went wrong, choose{" "}
              <strong>Report an issue</strong> at the top. The page you were on
              is filled in for you.
            </li>
            <li>
              Give it a short title, then say what you did, what happened and
              what you expected.
            </li>
            <li>
              Attach a screenshot: on Windows press Windows + Shift + S, on a
              Mac press Command + Shift + 4, on an Android phone press Power and
              Volume down together.
            </li>
            <li>
              Choose <strong>Create issue</strong>. You can follow it, and add
              comments or more screenshots, under <strong>Issues</strong>.
            </li>
          </ol>
        </Section>

        {apkUrl ? (
          <Section title="4. Android apps">
            <p>
              Open this link on your Android phone, download the app, and allow
              the installation when the phone asks. The iPhone app is not part
              of this test.
            </p>
            <p>
              <a
                href={apkUrl}
                className="font-medium text-accent"
                rel="noopener noreferrer"
                target="_blank"
              >
                Download the Android apps
              </a>
            </p>
          </Section>
        ) : null}

        <footer className="flex flex-wrap gap-4 border-t border-separator pt-5 text-sm">
          <Link href="/dashboard" className="font-medium text-accent">
            Open Sunpride Operations
          </Link>
          <Link href="/issues/new" className="font-medium text-muted">
            Report an issue
          </Link>
        </footer>
      </article>
    </main>
  );
}
