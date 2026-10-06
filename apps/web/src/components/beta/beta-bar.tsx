import { Notice, StatusPill } from "@sunpride/ui";
import Link from "next/link";
import { reportIssueHref } from "../../config/beta";

/** Roles that read the whole organization and therefore need no area of their own. */
const CROSS_SCOPE_ROLES = new Set(["super_admin", "analyst"]);

/**
 * Beta release strip shown at the top of every signed-in page: the Beta marker, the
 * tester guide and "Report an issue" (opens a new issue with this page prefilled).
 */
export function BetaBar({
  pathname,
  canReport,
}: {
  pathname: string;
  canReport: boolean;
}) {
  return (
    <section
      aria-label="Beta release"
      className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-surface-secondary px-3 py-2"
    >
      <div className="flex min-w-0 items-center gap-2 text-[13px] text-muted">
        <StatusPill tone="warning">Beta</StatusPill>
        <span>
          You are testing an early version. Tell us what does not work.
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-[13px]">
        <Link
          href="/help"
          className="font-medium text-muted hover:text-foreground"
        >
          Help for testers
        </Link>
        {canReport ? (
          <Link
            href={reportIssueHref(pathname)}
            className="inline-flex h-8 items-center rounded-lg border border-border bg-surface px-3 font-medium text-foreground hover:bg-default-soft"
          >
            Report an issue
          </Link>
        ) : null}
      </div>
    </section>
  );
}

/** True when a person's role needs an area but none has been assigned yet. */
export function needsAreaAssignment(
  profile: { role: string; orgUnitId?: string | null } | null | undefined,
) {
  return Boolean(
    profile && !CROSS_SCOPE_ROLES.has(profile.role) && !profile.orgUnitId,
  );
}

/** Clear message for a newly invited tester whose area is not assigned yet. */
export function AreaPendingNotice() {
  return (
    <div className="mb-4">
      <Notice
        tone="warning"
        title="You have not been assigned to an area yet"
        meta="You are signed in. Ask your administrator to assign you to your area; until then most pages stay empty. You can still read the tester guide and report an issue."
      />
    </div>
  );
}
