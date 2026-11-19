import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";

/** Contact for privacy questions (SP-0208). No official support mailbox exists in the repo yet. */
export const PRIVACY_CONTACT = "jcing.jc@gmail.com";
export const PRIVACY_UPDATED = "19 November 2026";

function Section({
  id,
  title,
  children,
}: {
  id?: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="grid gap-2 border-t border-separator pt-5">
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      <div className="grid gap-2 text-sm leading-6 text-muted">{children}</div>
    </section>
  );
}

const mail = (
  <a href={`mailto:${PRIVACY_CONTACT}`} className="font-medium text-accent">
    {PRIVACY_CONTACT}
  </a>
);

/**
 * SP-0208: public privacy policy for the Sunpride website and the Sunpride Field app.
 * Keep it accurate to the code: no ads or analytics SDKs, location kept 90 days
 * (apps/api/src/domains/fieldsync/location.js), encrypted phone database (SQLCipher).
 */
export function PrivacyPolicy() {
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
              Privacy policy
            </h1>
            <p className="text-sm text-muted">
              Sunpride Field app and Sunpride Operations website · Last updated{" "}
              {PRIVACY_UPDATED}
            </p>
          </div>
        </header>

        <Section title="Who we are">
          <p>
            The Sunpride Field app and this website are the sales system of
            Sunpride Foods. Cauld &amp; Clark IT Solutions builds and runs the
            system for Sunpride. For any privacy question, write to {mail}.
          </p>
          <p>
            The app is a work tool for Sunpride&apos;s salesmen, managers and
            office staff. Accounts are created by the Sunpride office; you
            cannot sign up in the app yourself.
          </p>
        </Section>

        <Section title="What we collect">
          <ul className="grid list-disc gap-1 pl-5">
            <li>
              <strong>Your account:</strong> your name, work email, phone number
              (if the office adds it), your role and team, and your password
              (stored only as a secure hash).
            </li>
            <li>
              <strong>Your phone:</strong> when you register a phone, the app
              creates its own random device ID and security key. We do not read
              your IMEI, SIM, contacts or other apps.
            </li>
            <li>
              <strong>Location:</strong> your precise location, only while
              location sharing is turned on for your working day (and when you
              pin a customer on the map or check in at a store). Sharing can
              continue in the background with a visible notification until you
              turn it off.
            </li>
            <li>
              <strong>Customers and stores:</strong> the store and customer
              details you enter (name, address, contact person and phone, map
              pin) and the storefront and shelf photos you take with the camera.
            </li>
            <li>
              <strong>Sales work:</strong> visits, orders, sales, receipts,
              returns, cash and cheque collections, stock and van records.
            </li>
            <li>
              <strong>Messages:</strong> the messages you send and receive in
              the app&apos;s chat.
            </li>
            <li>
              <strong>Basic diagnostics:</strong> the app keeps a short list of
              event codes (for example &quot;sync failed&quot; or
              &quot;crash&quot;) on the phone to help fix problems. It contains
              no customer data. We do not use any third-party crash reporting,
              analytics or advertising tools.
            </li>
          </ul>
          <p>
            Fingerprint or face unlock, if you use it, is handled by Android on
            your phone; we never receive your fingerprint or face data. The
            camera is also used to scan barcodes, and Bluetooth only to print
            receipts on a nearby printer.
          </p>
        </Section>

        <Section title="Why we use it">
          <p>
            Only to run Sunpride&apos;s sales operation: signing you in, keeping
            your phone secure, mapping customers, planning and checking store
            visits, recording sales and collections, printing receipts, keeping
            stock correct, messaging within the team, and reports for
            Sunpride&apos;s managers and office.
          </p>
        </Section>

        <Section title="Who can see it">
          <p>
            Sunpride&apos;s office staff and your managers, according to their
            role. Cauld &amp; Clark IT Solutions can access the system to run
            and support it, and the system runs on servers rented from hosting
            providers who store it for us.
          </p>
          <p>
            We do not sell your data. We do not share it with advertisers or
            data brokers. We only give it to others if the law requires it.
          </p>
        </Section>

        <Section title="How long we keep it">
          <p>
            Location history is deleted automatically after 90 days. Sales,
            collection and stock records are business and tax records and are
            kept for as long as Sunpride must keep them by law. Account details
            are kept while you work with Sunpride and removed or anonymised on
            request when no longer needed.
          </p>
        </Section>

        <Section title="How we protect it">
          <p>
            All data travels over encrypted HTTPS connections. On the phone, the
            app&apos;s database and sign-in details are encrypted and are not
            included in phone backups. Each phone is registered to your account
            and the office can block a phone at any time; the website and the
            app require your password.
          </p>
        </Section>

        <Section id="delete" title="Your choices, and deleting your data">
          <p>
            You can turn location sharing off at any time in the app. You can
            ask to see, correct or delete your personal data, or to delete your
            account, by emailing {mail} with your name and the email of your
            Sunpride account. We reply within 30 days.
          </p>
          <p>
            Your Sunpride administrator can also deactivate your account at any
            time, which stops all access straight away. Uninstalling the app
            removes everything stored on that phone. Some sales and collection
            records may have to be kept for legal reasons; we will tell you
            which.
          </p>
        </Section>

        <Section title="Children">
          <p>
            The app and website are work tools for adults and are not meant for
            anyone under 18.
          </p>
        </Section>

        <Section title="Changes">
          <p>
            If this policy changes, we update this page and the date at the top.
          </p>
        </Section>

        <footer className="flex flex-wrap gap-4 border-t border-separator pt-5 text-sm">
          <Link href="/help" className="font-medium text-accent">
            Help
          </Link>
          <Link href="/login" className="font-medium text-muted">
            Sign in
          </Link>
        </footer>
      </article>
    </main>
  );
}
