"use client";
import { Button } from "@heroui/react";
import { api } from "@sunpride/backend/api";
import type { Id } from "@sunpride/backend/data-model";
import { Card, FormField, StatusPill } from "@sunpride/ui";
import { useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import {
  DEFAULT_ISSUE_AREA,
  errorMessage,
  ISSUE_AREAS,
  ISSUE_PRIORITIES,
  MAX_SHORT_LENGTH,
  MAX_TEXT_LENGTH,
  MAX_TITLE_LENGTH,
  type IssuePriority,
} from "../../lib/issues";
import {
  IssueAccessState,
  IssuesBackLink,
  IssuesHeader,
  useIssueAccess,
} from "./issue-access";
import {
  AttachmentPicker,
  selectedFileError,
  uploadIssueFiles,
} from "./attachment-picker";
import { IssueStatusPill } from "./issue-pills";
export function IssueCreatePage() {
  const { access, canRead, loading } = useIssueAccess();
  const assignees = useQuery(
    api.issues.queries.assignees,
    canRead ? {} : "skip",
  );
  const createIssue = useMutation(api.issues.mutations.create);
  const generateUploadUrl = useMutation(api.issues.mutations.generateUploadUrl);
  const router = useRouter();
  const [fields, setFields] = useState({
    title: "",
    description: "",
    steps: "",
    actual: "",
    expected: "",
    area: "",
    priority: "medium",
    assignee: "",
    externalRef: "",
    milestone: "",
  });
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const uploadCache = useRef(
    new Map<File, { storageId: Id<"_storage">; fileName: string }>(),
  );
  const [error, setError] = useState("");
  function field(name: keyof typeof fields, value: string) {
    setFields((current) => ({ ...current, [name]: value }));
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!access?.canWrite || submitting.current) return;
    const problem = selectedFileError(files, access.maxVideoBytes);
    if (!fields.title.trim() || problem) {
      setError(problem ?? "Add an issue title");
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const uploads = await uploadIssueFiles(
        files,
        () => generateUploadUrl({}),
        uploadCache.current,
      );
      const result = await createIssue({
        title: fields.title.trim(),
        description: fields.description.trim() || undefined,
        steps: fields.steps.trim() || undefined,
        actual: fields.actual.trim() || undefined,
        expected: fields.expected.trim() || undefined,
        area: fields.area || DEFAULT_ISSUE_AREA,
        priority: fields.priority as IssuePriority,
        assigneeId: (fields.assignee || undefined) as
          Id<"profiles"> | undefined,
        externalRef: fields.externalRef.trim() || undefined,
        milestone: fields.milestone.trim() || undefined,
        uploads,
      });
      router.push(`/issues/${result.number}`);
    } catch (caught) {
      setError(errorMessage(caught, "Create failed. Try again."));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  if (!canRead || !access?.canWrite)
    return <IssueAccessState loading={loading} />;
  return (
    <form onSubmit={submit} className="grid gap-4">
      <IssuesBackLink />
      <IssuesHeader
        title="New issue"
        actions={<StatusPill>New issue · Backlog</StatusPill>}
      />
      {error ? (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      ) : null}
      <fieldset
        disabled={busy}
        className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]"
      >
        <div className="grid min-w-0 gap-4">
          <Card label="Issue summary">
            <div className="grid gap-4">
              <FormField label="Title *">
                <input
                  required
                  maxLength={MAX_TITLE_LENGTH}
                  value={fields.title}
                  onChange={(event) => field("title", event.target.value)}
                  placeholder="Briefly describe what is wrong"
                />
              </FormField>
              <FormField label="Description">
                <textarea
                  rows={5}
                  maxLength={MAX_TEXT_LENGTH}
                  value={fields.description}
                  onChange={(event) => field("description", event.target.value)}
                  placeholder="Impact and context"
                />
              </FormField>
            </div>
          </Card>
          <Card label="Reproduction and verification">
            <div className="grid gap-4">
              <FormField label="Steps to reproduce">
                <textarea
                  rows={5}
                  maxLength={MAX_TEXT_LENGTH}
                  value={fields.steps}
                  onChange={(event) => field("steps", event.target.value)}
                  placeholder={
                    "1. Open the affected page\n2. Perform the action\n3. Observe the result"
                  }
                />
              </FormField>
              <div className="grid gap-4 md:grid-cols-2">
                <FormField label="Actual behavior">
                  <textarea
                    rows={4}
                    maxLength={MAX_TEXT_LENGTH}
                    value={fields.actual}
                    onChange={(event) => field("actual", event.target.value)}
                    placeholder="What currently happens?"
                  />
                </FormField>
                <FormField label="Expected behavior">
                  <textarea
                    rows={4}
                    maxLength={MAX_TEXT_LENGTH}
                    value={fields.expected}
                    onChange={(event) => field("expected", event.target.value)}
                    placeholder="What should happen instead?"
                  />
                </FormField>
              </div>
            </div>
          </Card>
          <Card label="Attachments">
            <AttachmentPicker
              files={files}
              onChange={setFiles}
              maxVideoBytes={access.maxVideoBytes}
              disabled={busy}
            />
          </Card>
        </div>
        <aside className="min-w-0">
          <Card label="Issue settings">
            <div className="grid gap-4">
              <FormField
                label="Area (optional)"
                hint="Blank files under Others"
              >
                <select
                  value={fields.area}
                  onChange={(event) => field("area", event.target.value)}
                >
                  <option value="">No area selected</option>
                  {ISSUE_AREAS.map((area) => (
                    <option key={area}>{area}</option>
                  ))}
                </select>
              </FormField>
              <FormField label="Priority">
                <select
                  value={fields.priority}
                  onChange={(event) => field("priority", event.target.value)}
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
                  value={fields.assignee}
                  onChange={(event) => field("assignee", event.target.value)}
                >
                  <option value="">Unassigned</option>
                  {assignees?.map((person) => (
                    <option key={person._id} value={person._id}>
                      {person.name}
                    </option>
                  ))}
                </select>
              </FormField>
              <FormField label="Reference">
                <input
                  maxLength={MAX_SHORT_LENGTH}
                  value={fields.externalRef}
                  onChange={(event) => field("externalRef", event.target.value)}
                  placeholder="#123 or SOP-004"
                />
              </FormField>
              <FormField label="Milestone">
                <input
                  maxLength={MAX_SHORT_LENGTH}
                  value={fields.milestone}
                  onChange={(event) => field("milestone", event.target.value)}
                  placeholder="Optional milestone"
                />
              </FormField>
              <div className="grid gap-2 rounded-xl bg-surface-secondary p-3">
                <p className="text-[11px] uppercase tracking-wide text-muted">
                  Starting status
                </p>
                <IssueStatusPill status="draft" />
                <p className="text-[12px] text-muted">
                  Reporter, number and times are recorded automatically.
                </p>
              </div>
            </div>
          </Card>
        </aside>
      </fieldset>
      <footer className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 border-t border-separator bg-surface/95 py-4 backdrop-blur">
        <p className="text-[13px] text-muted">
          Fields marked with * are required.
        </p>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            isDisabled={busy}
            onPress={() => router.push("/issues")}
          >
            Cancel
          </Button>
          <Button type="submit" variant="primary" isPending={busy}>
            Create issue
          </Button>
        </div>
      </footer>
    </form>
  );
}
