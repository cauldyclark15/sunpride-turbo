"use client";

import { useState } from "react";
import { copyText, type CopyStatus } from "./app-links/app-links";

/** Keep the displayed code on one line without shortening the value we copy. */
export function PhoneCode({ value }: { value: string }) {
  const [status, setStatus] = useState<CopyStatus>("idle");
  return (
    <div className="grid min-w-0 gap-1">
      <div className="flex min-w-0 items-center gap-2">
        <span
          className="min-w-0 flex-1 truncate font-mono text-sm"
          title={value}
        >
          {value}
        </span>
        <button
          type="button"
          className="min-h-9 shrink-0 rounded-lg border border-border px-2 text-xs font-medium hover:bg-default-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          aria-label={`Copy phone code ${value}`}
          title="Copy full phone code"
          onClick={async () => {
            setStatus((await copyText(value)) ? "copied" : "failed");
          }}
        >
          {status === "copied" ? "Copied" : "Copy"}
        </button>
      </div>
      <span
        role="status"
        className={status === "failed" ? "text-xs text-danger" : "sr-only"}
      >
        {status === "copied"
          ? "Phone code copied."
          : status === "failed"
            ? "Could not copy. Select the phone code to copy it."
            : ""}
      </span>
    </div>
  );
}
