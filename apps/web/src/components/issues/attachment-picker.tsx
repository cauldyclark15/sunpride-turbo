"use client";
import { Button } from "@heroui/react";
import type { Id } from "@sunpride/backend/data-model";
import { WorkspaceIcon } from "@sunpride/ui";
import { useRef, useState } from "react";
import {
  ATTACHMENT_ACCEPT,
  formatFileSize,
  MAX_ATTACHMENTS_PER_COMMENT,
  validateAttachment,
} from "../../lib/issues";
type Upload = { storageId: Id<"_storage">; fileName: string };
/** Preserve successful uploads across a failed submission. */
export async function uploadIssueFiles(
  files: File[],
  generateUploadUrl: () => Promise<string>,
  cache: Map<File, Upload> = new Map(),
): Promise<Upload[]> {
  const uploads: Upload[] = [];
  for (const file of files) {
    let upload = cache.get(file);
    if (!upload) {
      const url = await generateUploadUrl();
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!response.ok) throw new Error("Upload failed. Try again.");
      const data: unknown = await response.json();
      if (
        !data ||
        typeof data !== "object" ||
        !("storageId" in data) ||
        typeof data.storageId !== "string"
      )
        throw new Error("Upload failed. Try again.");
      upload = {
        storageId: data.storageId as Id<"_storage">,
        fileName: file.name,
      };
      cache.set(file, upload);
    }
    uploads.push(upload);
  }
  return uploads;
}
export function selectedFileError(
  files: File[],
  maxVideoBytes: number,
): string | undefined {
  if (files.length > MAX_ATTACHMENTS_PER_COMMENT)
    return "Use five attachments or fewer";
  for (const file of files) {
    const error = validateAttachment({
      fileType: file.type,
      fileSize: file.size,
      maxVideoBytes,
    });
    if (error) return `${file.name}: ${error}`;
  }
}
export function AttachmentPicker({
  files,
  onChange,
  maxVideoBytes,
  disabled = false,
}: {
  files: File[];
  onChange: (files: File[]) => void;
  maxVideoBytes: number;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  function choose(selected: File[]) {
    if (disabled) return;
    const next = [...files, ...selected];
    const problem = selectedFileError(next, maxVideoBytes);
    setError(problem ?? "");
    if (!problem) onChange(next);
  }
  return (
    <div className="grid gap-3">
      <div
        className={`grid justify-items-center gap-2 rounded-xl border border-dashed p-5 text-center ${dragging ? "border-accent bg-accent-soft" : "border-border"}`}
        onDragOver={(event) => {
          if (disabled) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          choose(Array.from(event.dataTransfer.files));
        }}
      >
        <WorkspaceIcon name="attachment" className="size-5 text-muted" />
        <p className="text-[13px] text-muted">Drop files here</p>
        <Button
          type="button"
          variant="outline"
          isDisabled={disabled || files.length >= MAX_ATTACHMENTS_PER_COMMENT}
          onPress={() => input.current?.click()}
        >
          Attach files
        </Button>
        <p className="text-[12px] text-muted">
          Up to 5 · Images 10 MB · Documents 25 MB · Videos{" "}
          {maxVideoBytes / (1024 * 1024)} MB
        </p>
        <input
          ref={input}
          type="file"
          multiple
          accept={ATTACHMENT_ACCEPT}
          className="hidden"
          aria-label="Choose attachments"
          disabled={disabled}
          onChange={(event) => {
            choose(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
      </div>
      {error ? (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      ) : null}
      {files.length ? (
        <ul className="divide-y divide-separator">
          {files.map((file, index) => (
            <li
              key={`${file.name}-${index}`}
              className="flex min-h-12 items-center gap-2"
            >
              <WorkspaceIcon name="document" className="size-4 text-muted" />
              <span className="min-w-0 flex-1 truncate text-[13px]">
                {file.name}
                <span className="ml-2 text-muted">
                  {formatFileSize(file.size)}
                </span>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                isIconOnly
                aria-label={`Remove ${file.name}`}
                isDisabled={disabled}
                onPress={() => {
                  onChange(files.filter((_, i) => i !== index));
                  setError("");
                }}
              >
                <WorkspaceIcon name="close" className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
