"use client";
import { Button } from "@heroui/react";
import { WorkspaceIcon } from "@sunpride/ui";
import { useRef, useState } from "react";
import {
  ATTACHMENT_ACCEPT,
  formatFileSize,
  MAX_ATTACHMENTS_PER_COMMENT,
  validateAttachment,
} from "../../lib/issues";
import { apiFetch, ApiError } from "../../lib/api";
type Upload = { storageId: string; fileName: string };
export type IssueUploadClaim = {
  uploadId: string;
  uploadToken: string;
  uploadUrl: string;
  chunkUrl: string;
  chunkBytes: number;
  expiresAt: number;
};
/** Preserve confirmed stored blobs across a failed submission. */
export async function uploadIssueFiles(
  files: File[],
  claim: (input: {
    mime: string;
    size: number;
    sha256: string;
    ownerId: string | null;
  }) => Promise<IssueUploadClaim> = (input) =>
    apiFetch("/api/v1/issues/uploads/claim", { method: "POST", body: input }),
  cache: Map<File, Upload> = new Map(),
  ownerId: string | null = null,
): Promise<Upload[]> {
  const uploads: Upload[] = [];
  for (const file of files) {
    let upload = cache.get(file);
    if (!upload) {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        await file.arrayBuffer(),
      );
      const sha256 = Array.from(new Uint8Array(digest), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("");
      const c = await claim({
        mime: file.type,
        size: file.size,
        sha256,
        ownerId,
      });
      if (
        !Number.isSafeInteger(c.chunkBytes) ||
        c.chunkBytes < 1 ||
        typeof c.uploadId !== "string" ||
        typeof c.uploadToken !== "string"
      )
        throw new ApiError({
          code: "upload_failed",
          message: "Upload claim was invalid. Try again.",
        });
      let stored = false;
      for (
        let offset = 0, index = 0;
        offset < file.size;
        offset += c.chunkBytes, index++
      ) {
        const chunked = file.size > c.chunkBytes;
        const response = await fetch(
          chunked ? `${c.chunkUrl}/${index}` : c.uploadUrl,
          {
            method: "PUT",
            headers: {
              "Content-Type": file.type,
              Authorization: `Bearer ${c.uploadToken}`,
            },
            body: chunked
              ? file.slice(offset, offset + c.chunkBytes, file.type)
              : file,
          },
        );
        const result: unknown = await response.json();
        if (!response.ok)
          throw new ApiError({
            code: "upload_failed",
            message: "Upload failed. Try again.",
            status: response.status,
          });
        if (
          result &&
          typeof result === "object" &&
          "status" in result &&
          result.status === "stored" &&
          "blobId" in result &&
          result.blobId === c.uploadId
        ) {
          stored = true;
          break;
        }
        if (!chunked) break;
      }
      if (!stored)
        throw new ApiError({
          code: "upload_failed",
          message: "Upload was not confirmed. Try again.",
        });
      upload = { storageId: c.uploadId, fileName: file.name };
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
