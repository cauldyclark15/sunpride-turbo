"use client";
import { Button } from "@heroui/react";
import { api } from "@sunpride/backend/api";
import type { Id } from "@sunpride/backend/data-model";
import {
  Card,
  EmptyPanel,
  FormField,
  PageHeader,
  StatusPill,
  UnderlineTabs,
  WorkspaceIcon,
} from "@sunpride/ui";
import { useMutation, useQuery } from "convex/react";
import { useRef, useState, type FormEvent } from "react";
import {
  activityText,
  errorMessage,
  ISSUE_AREAS,
  ISSUE_PRIORITIES,
  ISSUE_STATUSES,
  ISSUE_STATUS_LABELS,
  MAX_TEXT_LENGTH,
  MAX_TITLE_LENGTH,
  type IssuePriority,
  type IssueStatus,
} from "../../lib/issues";
import {
  IssueAccessState,
  IssuesBackLink,
  useIssueAccess,
  type IssueAccess,
  type IssueAssignee,
  type IssueDetail,
} from "./issue-access";
import {
  AttachmentPicker,
  selectedFileError,
  uploadIssueFiles,
} from "./attachment-picker";
import { AttachmentRenderer } from "./attachment-renderer";
import { IssuePriorityPill, IssueStatusPill } from "./issue-pills";
import { IssueTimestamp } from "./issue-timestamp";

type Comment = IssueDetail["comments"][number];
type EditFields = {
  title: string;
  description: string;
  steps: string;
  actual: string;
  expected: string;
  externalRef: string;
  milestone: string;
};
export function IssueDetailPage({ number }: { number: string }) {
  const { access, canRead, loading } = useIssueAccess();
  const detail = useQuery(
    api.issues.queries.detail,
    canRead ? { number } : "skip",
  );
  const assignees = useQuery(
    api.issues.queries.assignees,
    canRead ? {} : "skip",
  );
  if (!canRead || !access) return <IssueAccessState loading={loading} />;
  if (detail === undefined)
    return (
      <p role="status" className="text-[13px] text-muted">
        Loading issue…
      </p>
    );
  if (detail === null)
    return (
      <div className="grid gap-4">
        <IssuesBackLink />
        <EmptyPanel title="Issue not found" />
      </div>
    );
  return (
    <IssueDetailContent
      key={detail.issue._id}
      detail={detail}
      access={access}
      assignees={assignees ?? []}
    />
  );
}
export function IssueActivity({
  activity,
}: {
  activity: IssueDetail["activity"];
}) {
  return (
    <div className="grid gap-4">
      {activity.length ? (
        activity.map((event) => (
          <article
            key={event._id}
            className="border-b border-separator pb-4 last:border-0 last:pb-0"
          >
            <p className="text-[13px]">
              <span className="font-medium">{event.actorName}</span>{" "}
              {activityText(event)}
            </p>
            <p className="mt-1 text-xs text-muted">
              <IssueTimestamp
                value={event.createdAt}
                label="Activity recorded"
              />
            </p>
            {event.note ? (
              <p className="mt-2 whitespace-pre-wrap text-[13px] text-muted">
                {event.note}
              </p>
            ) : null}
          </article>
        ))
      ) : (
        <p className="text-[13px] text-muted">No activity yet</p>
      )}
    </div>
  );
}
function IssueEditor({
  detail,
  busy,
  onCancel,
  onSave,
}: {
  detail: IssueDetail;
  busy: boolean;
  onCancel: () => void;
  onSave: (fields: EditFields) => Promise<void>;
}) {
  const issue = detail.issue;
  const [fields, setFields] = useState<EditFields>({
    title: issue.title,
    description: issue.description ?? "",
    steps: issue.steps ?? "",
    actual: issue.actual ?? "",
    expected: issue.expected ?? "",
    externalRef: issue.externalRef ?? "",
    milestone: issue.milestone ?? "",
  });
  const labels = {
    title: "Title *",
    description: "Description",
    steps: "Steps to reproduce",
    actual: "Actual behavior",
    expected: "Expected behavior",
    externalRef: "Reference",
    milestone: "Milestone",
  };
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!fields.title.trim()) return;
    void onSave(fields);
  }
  return (
    <form onSubmit={submit} className="grid gap-4">
      <fieldset disabled={busy} className="grid min-w-0 gap-4">
        {(Object.keys(labels) as (keyof EditFields)[]).map((key) => (
          <FormField key={key} label={labels[key]}>
            {["title", "externalRef", "milestone"].includes(key) ? (
              <input
                required={key === "title"}
                maxLength={MAX_TITLE_LENGTH}
                value={fields[key]}
                onChange={(event) =>
                  setFields((current) => ({
                    ...current,
                    [key]: event.target.value,
                  }))
                }
              />
            ) : (
              <textarea
                rows={4}
                maxLength={MAX_TEXT_LENGTH}
                value={fields[key]}
                onChange={(event) =>
                  setFields((current) => ({
                    ...current,
                    [key]: event.target.value,
                  }))
                }
              />
            )}
          </FormField>
        ))}
      </fieldset>
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          isDisabled={busy}
          onPress={onCancel}
        >
          Cancel
        </Button>
        <Button type="submit" variant="primary" isPending={busy}>
          Save issue
        </Button>
      </div>
    </form>
  );
}
function IssueComment({
  comment,
  writable,
  busy,
  onEdit,
  onDelete,
  onRemove,
}: {
  comment: Comment;
  writable: boolean;
  busy: boolean;
  onEdit: (body: string) => Promise<boolean>;
  onDelete: () => void;
  onRemove: (attachment: Comment["attachments"][number]) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(comment.body);
  return (
    <article
      className="grid gap-3 border-b border-separator pb-4 last:border-0"
      aria-label={`Comment by ${comment.authorName}`}
    >
      <header className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[13px] font-medium">{comment.authorName}</p>
          <p className="text-xs text-muted">
            <IssueTimestamp value={comment.createdAt} label="Comment posted" />
            {comment.updatedAt ? (
              <>
                {" "}
                · edited{" "}
                <IssueTimestamp
                  value={comment.updatedAt}
                  label="Comment edited"
                />
              </>
            ) : null}
          </p>
        </div>
        <div className="flex gap-1">
          {writable && comment.canEdit && !editing ? (
            <Button
              variant="ghost"
              size="sm"
              isIconOnly
              isDisabled={busy}
              aria-label={`Edit comment by ${comment.authorName}`}
              onPress={() => {
                setBody(comment.body);
                setEditing(true);
              }}
            >
              <WorkspaceIcon name="edit" className="size-4" />
            </Button>
          ) : null}
          {writable && comment.canDelete ? (
            <Button
              variant="ghost"
              size="sm"
              isIconOnly
              isDisabled={busy}
              aria-label={`Delete comment by ${comment.authorName}`}
              onPress={onDelete}
            >
              <WorkspaceIcon name="trash" className="size-4 text-danger" />
            </Button>
          ) : null}
        </div>
      </header>
      {editing ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void onEdit(body).then((saved) => {
              if (saved) setEditing(false);
            });
          }}
          className="grid gap-2"
        >
          <FormField label="Edit comment">
            <textarea
              rows={4}
              maxLength={MAX_TEXT_LENGTH}
              value={body}
              disabled={busy}
              onChange={(event) => setBody(event.target.value)}
            />
          </FormField>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              isDisabled={busy}
              onPress={() => setEditing(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="outline"
              isDisabled={busy || (!body.trim() && !comment.attachments.length)}
            >
              Save comment
            </Button>
          </div>
        </form>
      ) : comment.body ? (
        <p className="whitespace-pre-wrap break-words text-[13px] leading-6">
          {comment.body}
        </p>
      ) : null}
      {comment.attachments.length ? (
        <AttachmentRenderer
          attachments={comment.attachments}
          canDelete={writable && comment.canDelete}
          disabled={busy}
          onRemove={onRemove}
        />
      ) : null}
    </article>
  );
}
function IssueDetailContent({
  detail,
  access,
  assignees,
}: {
  detail: IssueDetail;
  access: IssueAccess;
  assignees: IssueAssignee[];
}) {
  const issue = detail.issue;
  const writable = access.canWrite && !issue.archived;
  // Status, area, priority, assignee and editing the issue are triage work; every tester
  // can still comment and attach.
  const triage = writable && access.canTriage;
  const update = useMutation(api.issues.mutations.update);
  const move = useMutation(api.issues.mutations.move);
  const archive = useMutation(api.issues.mutations.archive);
  const restore = useMutation(api.issues.mutations.restore);
  const addComment = useMutation(api.issues.mutations.addComment);
  const updateComment = useMutation(api.issues.mutations.updateComment);
  const deleteComment = useMutation(api.issues.mutations.deleteComment);
  const removeAttachment = useMutation(api.issues.mutations.removeAttachment);
  const generateUploadUrl = useMutation(api.issues.mutations.generateUploadUrl);
  const [tab, setTab] = useState<"discussion" | "activity">("discussion");
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const uploadCache = useRef(
    new Map<File, { storageId: Id<"_storage">; fileName: string }>(),
  );
  const [error, setError] = useState("");
  async function perform(
    operation: () => Promise<unknown>,
    failure = "Save failed. Try again.",
  ): Promise<boolean> {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      await operation();
      return true;
    } catch (caught) {
      setError(errorMessage(caught, failure));
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function postComment(event: FormEvent) {
    event.preventDefault();
    if (!writable || (!body.trim() && !files.length)) return;
    const problem = selectedFileError(files, access.maxVideoBytes);
    if (problem) {
      setError(problem);
      return;
    }
    const saved = await perform(async () => {
      const uploads = await uploadIssueFiles(
        files,
        () => generateUploadUrl({}),
        uploadCache.current,
      );
      await addComment({ issueId: issue._id, body: body.trim(), uploads });
    }, "Comment failed. Try again.");
    if (saved) {
      setBody("");
      setFiles([]);
      uploadCache.current.clear();
    }
  }
  async function saveIssue(fields: EditFields) {
    if (!triage) return;
    const saved = await perform(() =>
      update({
        issueId: issue._id,
        title: fields.title.trim(),
        description: fields.description.trim() || null,
        steps: fields.steps.trim() || null,
        actual: fields.actual.trim() || null,
        expected: fields.expected.trim() || null,
        externalRef: fields.externalRef.trim() || null,
        milestone: fields.milestone.trim() || null,
      }),
    );
    if (saved) setEditing(false);
  }
  const details = [
    ["Description", issue.description],
    ["Steps to reproduce", issue.steps],
    ["Actual behavior", issue.actual],
    ["Expected behavior", issue.expected],
  ];
  return (
    <div className="grid min-w-0 gap-4">
      <IssuesBackLink />
      <div className="flex flex-wrap gap-2">
        <span className="rounded-md bg-default-soft px-2 py-0.5 font-mono text-xs text-muted">
          {detail.key}
        </span>
        <StatusPill>{issue.area}</StatusPill>
        {issue.milestone ? <StatusPill>{issue.milestone}</StatusPill> : null}
        {issue.externalRef ? (
          <StatusPill>{issue.externalRef}</StatusPill>
        ) : null}
        {issue.archived ? <StatusPill>Archived</StatusPill> : null}
      </div>
      <PageHeader
        title={issue.title}
        meta={
          <>
            Reported by {detail.reporterName} ·{" "}
            <IssueTimestamp value={issue.createdAt} label="Reported" /> ·
            updated <IssueTimestamp value={issue.updatedAt} />
          </>
        }
      />
      {error ? (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      ) : null}
      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="grid min-w-0 content-start gap-4">
          <Card label="Issue details">
            {editing && triage ? (
              <IssueEditor
                detail={detail}
                busy={busy}
                onCancel={() => setEditing(false)}
                onSave={saveIssue}
              />
            ) : (
              <div className="grid gap-4">
                {details.some(([, value]) => value) ? (
                  details.map(([label, value]) =>
                    value ? (
                      <section key={label}>
                        <h3 className="mb-1.5 text-[13px] font-medium">
                          {label}
                        </h3>
                        <p className="whitespace-pre-wrap break-words text-[13px] leading-6 text-muted">
                          {value}
                        </p>
                      </section>
                    ) : null,
                  )
                ) : (
                  <p className="text-[13px] text-muted">No details added</p>
                )}
              </div>
            )}
          </Card>
          <section
            aria-label="Issue discussion and activity"
            className="min-w-0 overflow-hidden rounded-2xl border border-border bg-surface"
          >
            <div className="px-4">
              <UnderlineTabs
                label="Issue conversation"
                items={
                  [
                    ["discussion", `Discussion (${issue.commentCount})`],
                    ["activity", "Activity"],
                  ] as const
                }
                activeId={tab}
                onChange={setTab}
              />
            </div>
            <div className="grid gap-4 p-4">
              {tab === "activity" ? (
                <IssueActivity activity={detail.activity} />
              ) : (
                <>
                  {detail.comments.length ? (
                    detail.comments.map((comment) => (
                      <IssueComment
                        key={comment._id}
                        comment={comment}
                        writable={writable}
                        busy={busy}
                        onEdit={(value) =>
                          writable
                            ? perform(() =>
                                updateComment({
                                  commentId: comment._id,
                                  body: value.trim(),
                                }),
                              )
                            : Promise.resolve(false)
                        }
                        onDelete={() => {
                          if (
                            writable &&
                            window.confirm("Delete this comment?")
                          )
                            void perform(() =>
                              deleteComment({ commentId: comment._id }),
                            );
                        }}
                        onRemove={(attachment) => {
                          if (
                            writable &&
                            window.confirm("Remove this attachment?")
                          )
                            void perform(() =>
                              removeAttachment({
                                attachmentId: attachment._id,
                              }),
                            );
                        }}
                      />
                    ))
                  ) : (
                    <p className="text-[13px] text-muted">No comments yet</p>
                  )}
                  {writable && !editing ? (
                    <form
                      className="grid gap-3 border-t border-separator pt-4"
                      onSubmit={(event) => void postComment(event)}
                    >
                      <FormField label="Add a comment">
                        <textarea
                          rows={4}
                          maxLength={MAX_TEXT_LENGTH}
                          value={body}
                          disabled={busy}
                          onChange={(event) => setBody(event.target.value)}
                          placeholder="Write a comment"
                        />
                      </FormField>
                      <AttachmentPicker
                        files={files}
                        onChange={setFiles}
                        maxVideoBytes={access.maxVideoBytes}
                        disabled={busy}
                      />
                      <div className="flex justify-end">
                        <Button
                          type="submit"
                          variant="primary"
                          isPending={busy}
                          isDisabled={!body.trim() && !files.length}
                        >
                          Comment
                        </Button>
                      </div>
                    </form>
                  ) : null}
                </>
              )}
            </div>
          </section>
        </div>
        <aside className="h-fit min-w-0 xl:sticky xl:top-4">
          <Card label="Settings">
            <div className="grid gap-4">
              {triage ? (
                <>
                  <FormField label="Status">
                    <select
                      aria-label="Issue status"
                      value={issue.status}
                      disabled={busy}
                      onChange={(event) =>
                        void perform(() =>
                          move({
                            issueId: issue._id,
                            status: event.target.value as IssueStatus,
                          }),
                        )
                      }
                    >
                      {ISSUE_STATUSES.map((status) => (
                        <option key={status} value={status}>
                          {ISSUE_STATUS_LABELS[status]}
                        </option>
                      ))}
                    </select>
                  </FormField>
                  <FormField label="Area">
                    <select
                      aria-label="Issue area"
                      value={issue.area}
                      disabled={busy}
                      onChange={(event) =>
                        void perform(() =>
                          update({
                            issueId: issue._id,
                            area: event.target.value,
                          }),
                        )
                      }
                    >
                      {[...new Set([...ISSUE_AREAS, issue.area])].map(
                        (area) => (
                          <option key={area}>{area}</option>
                        ),
                      )}
                    </select>
                  </FormField>
                  <FormField label="Priority">
                    <select
                      aria-label="Issue priority"
                      value={issue.priority}
                      disabled={busy}
                      onChange={(event) =>
                        void perform(() =>
                          update({
                            issueId: issue._id,
                            priority: event.target.value as IssuePriority,
                          }),
                        )
                      }
                    >
                      {ISSUE_PRIORITIES.map((priority) => (
                        <option key={priority} value={priority}>
                          {priority.charAt(0).toUpperCase() + priority.slice(1)}
                        </option>
                      ))}
                    </select>
                  </FormField>
                  <FormField label="Assignee">
                    <select
                      aria-label="Issue assignee"
                      value={issue.assigneeId ?? ""}
                      disabled={busy}
                      onChange={(event) =>
                        void perform(() =>
                          update({
                            issueId: issue._id,
                            assigneeId: (event.target.value ||
                              null) as Id<"profiles"> | null,
                          }),
                        )
                      }
                    >
                      <option value="">Unassigned</option>
                      {issue.assigneeId &&
                      !assignees.some(
                        (person) => person._id === issue.assigneeId,
                      ) ? (
                        <option value={issue.assigneeId}>
                          {detail.assigneeName ?? "Former user"}
                        </option>
                      ) : null}
                      {assignees.map((person) => (
                        <option key={person._id} value={person._id}>
                          {person.name}
                        </option>
                      ))}
                    </select>
                  </FormField>
                </>
              ) : (
                <dl className="grid gap-4 text-[13px]">
                  {[
                    [
                      "Status",
                      <IssueStatusPill key="status" status={issue.status} />,
                    ],
                    ["Area", issue.area],
                    [
                      "Priority",
                      <IssuePriorityPill
                        key="priority"
                        priority={issue.priority}
                      />,
                    ],
                    ["Assignee", detail.assigneeName ?? "Unassigned"],
                  ].map(([label, value]) => (
                    <div key={String(label)}>
                      <dt className="mb-1 text-[11px] uppercase tracking-wide text-muted">
                        {label}
                      </dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              <dl className="grid gap-4 border-t border-separator pt-4 text-[13px]">
                {[
                  ["Reporter", detail.reporterName],
                  ["Reference", issue.externalRef ?? "—"],
                  ["Milestone", issue.milestone ?? "—"],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="mb-1 text-[11px] uppercase tracking-wide text-muted">
                      {label}
                    </dt>
                    <dd className="break-words">{value}</dd>
                  </div>
                ))}
              </dl>
              {triage || access.canManage ? (
                <div className="grid gap-2 border-t border-separator pt-4">
                  {triage ? (
                    <Button
                      variant="outline"
                      isDisabled={busy || editing}
                      onPress={() => setEditing(true)}
                    >
                      <WorkspaceIcon name="edit" className="size-4" />
                      Edit issue
                    </Button>
                  ) : null}
                  {access.canManage ? (
                    <Button
                      variant="outline"
                      isDisabled={busy}
                      onPress={() => {
                        if (
                          window.confirm(
                            issue.archived
                              ? "Restore this issue?"
                              : "Archive this issue?",
                          )
                        )
                          void perform(() =>
                            issue.archived
                              ? restore({ issueId: issue._id })
                              : archive({ issueId: issue._id }),
                          );
                      }}
                    >
                      <WorkspaceIcon
                        name={issue.archived ? "restore" : "archive"}
                        className="size-4"
                      />
                      {issue.archived ? "Restore issue" : "Archive issue"}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </Card>
        </aside>
      </div>
    </div>
  );
}
