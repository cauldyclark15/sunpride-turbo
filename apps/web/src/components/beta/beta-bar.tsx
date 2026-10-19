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
      className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-surface-secondary px-3 py-2 max-sm:mb-3 max-sm:flex-nowrap max-sm:py-1"
    >
      <div className="flex min-w-0 items-center gap-2 text-[13px] text-muted">
        <StatusPill tone="warning">Beta</StatusPill>
        <span className="max-sm:hidden">
          You are testing an early version. Tell us what does not work.
        </span>
        <span className="truncate sm:hidden">Early version</span>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-3 text-[13px] max-sm:gap-1">
        <Link
          href="/help"
          className="inline-flex items-center font-medium text-muted hover:text-foreground max-lg:min-h-11 max-sm:px-2"
        >
          <span className="max-sm:hidden">Help for testers</span>
          <span className="sm:hidden">Help</span>
        </Link>
        {canReport ? (
          <Link
            href={reportIssueHref(pathname)}
            className="inline-flex h-8 items-center rounded-lg border border-border bg-surface px-3 font-medium text-foreground hover:bg-default-soft"
          >
            <span className="max-sm:hidden">Report an issue</span>
            <span className="sm:hidden">Report</span>
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
