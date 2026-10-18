import type { IssuePriority, IssueStatus } from "../../lib/issues";
export type IssueAccess = {
  canRead: boolean;
  canWrite: boolean;
  canTriage: boolean;
  canManage: boolean;
  maxVideoBytes: number;
};
export type IssueAssignee = { _id: string; name: string; role: string };
export type Issue = {
  _id: string;
  number: number;
  title: string;
  description?: string;
  steps?: string;
  actual?: string;
  expected?: string;
  area: string;
  priority: IssuePriority;
  status: IssueStatus;
  order: number;
  assigneeId?: string;
  reporterId?: string;
  externalRef?: string;
  milestone?: string;
  archived: boolean;
  archivedAt?: number;
  commentCount: number;
  attachmentCount: number;
  lastCommentAt?: number;
  createdAt: number;
  updatedAt: number;
  backup?: {
    summaryOnly: boolean;
    missingComments: number;
    missingAttachments: number;
  };
};
export type IssueCard = Omit<Issue, "archived"> & {
  key: string;
  reporterName: string;
  assigneeName?: string;
  lastCommentAuthorName?: string;
};
export type IssueBoard = {
  issues: IssueCard[];
  counts: Record<IssueStatus, number>;
  milestones: string[];
  truncated: boolean;
  total: number;
  summary: {
    open: number;
    urgent: number;
    unassigned: number;
    readyForRetest: number;
    completedThisWeek: number;
    completedPriorWeek: number | null;
  };
  trend: { date: string; opened: number; completed: number; known?: boolean }[];
  historyNote: string;
};
export type IssueAttachment = {
  _id: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  kind: "image" | "video" | "document";
  url: string | null;
};
export type IssueDetail = {
  issue: Issue;
  key: string;
  reporterName: string;
  assigneeName?: string;
  comments: {
    _id: string;
    authorId?: string;
    authorName: string;
    body: string;
    createdAt: number;
    updatedAt?: number;
    canEdit: boolean;
    canDelete: boolean;
    attachments: IssueAttachment[];
  }[];
  activity: {
    _id: string;
    kind: string;
    actorName: string;
    fromStatus?: IssueStatus;
    toStatus?: IssueStatus;
    changes?: { field: string; from: string | null; to: string | null }[];
    note?: string;
    createdAt: number;
  }[];
};
