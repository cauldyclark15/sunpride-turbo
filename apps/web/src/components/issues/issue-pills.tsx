import { StatusPill } from "@sunpride/ui";
import {
  ISSUE_STATUS_LABELS,
  ISSUE_STATUS_TONES,
  type IssuePriority,
  type IssueStatus,
} from "../../lib/issues";
export function IssueStatusPill({ status }: { status: IssueStatus }) {
  return (
    <StatusPill tone={ISSUE_STATUS_TONES[status]}>
      {ISSUE_STATUS_LABELS[status]}
    </StatusPill>
  );
}
export function IssuePriorityPill({ priority }: { priority: IssuePriority }) {
  return (
    <StatusPill
      tone={
        priority === "critical"
          ? "danger"
          : priority === "high"
            ? "warning"
            : "neutral"
      }
    >
      {priority}
    </StatusPill>
  );
}
