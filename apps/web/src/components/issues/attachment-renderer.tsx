"use client";
import Image from "next/image";
import { Button } from "@heroui/react";
import { WorkspaceIcon } from "@sunpride/ui";
import { useState } from "react";
import { formatFileSize } from "../../lib/issues";
import type { IssueDetail } from "./issue-access";
type Attachment = IssueDetail["comments"][number]["attachments"][number];
function VideoAttachment({ attachment }: { attachment: Attachment }) {
  const [failed, setFailed] = useState(false);
  return (
    <>
      {failed ? (
        <p className="p-4 text-[13px] text-muted">
          Cannot play video. Open the original.
        </p>
      ) : (
        <video
          controls
          preload="metadata"
          src={attachment.url ?? undefined}
          aria-label={attachment.fileName}
          className="h-40 w-full bg-surface-secondary"
          onError={() => setFailed(true)}
        >
          Your browser cannot play this video.
        </video>
      )}
      <a
        href={attachment.url ?? undefined}
        target="_blank"
        rel="noopener noreferrer"
        className="block px-3 py-2 text-[13px] text-accent"
      >
        Open original
      </a>
    </>
  );
}
export function AttachmentRenderer({
  attachments,
  canDelete = false,
  disabled = false,
  onRemove,
}: {
  attachments: Attachment[];
  canDelete?: boolean;
  disabled?: boolean;
  onRemove?: (attachment: Attachment) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {attachments.map((attachment) => (
        <article
          key={attachment._id}
          className="relative min-w-0 overflow-hidden rounded-xl border border-border bg-surface"
        >
          {attachment.url ? (
            attachment.kind === "image" ? (
              <a
                href={attachment.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Open ${attachment.fileName}`}
              >
                <Image
                  src={attachment.url}
                  alt={attachment.fileName}
                  unoptimized
                  width={360}
                  height={180}
                  className="h-40 w-full object-cover"
                />
              </a>
            ) : attachment.kind === "video" ? (
              <VideoAttachment attachment={attachment} />
            ) : (
              <a
                href={attachment.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex h-40 items-center justify-center gap-2 text-[13px] text-accent"
              >
                <WorkspaceIcon name="document" className="size-6" />
                Open document
              </a>
            )
          ) : (
            <p className="flex h-40 items-center justify-center text-[13px] text-muted">
              File unavailable
            </p>
          )}
          <div className="border-t border-separator px-3 py-2">
            <p
              className="truncate text-[12px] font-medium"
              title={attachment.fileName}
            >
              {attachment.fileName}
            </p>
            <p className="text-[12px] text-muted">
              {formatFileSize(attachment.fileSize)}
            </p>
          </div>
          {canDelete && onRemove ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              isIconOnly
              isDisabled={disabled}
              aria-label={`Remove ${attachment.fileName}`}
              className="absolute right-2 top-2 bg-surface text-danger"
              onPress={() => onRemove(attachment)}
            >
              <WorkspaceIcon name="close" className="size-4" />
            </Button>
          ) : null}
        </article>
      ))}
    </div>
  );
}
