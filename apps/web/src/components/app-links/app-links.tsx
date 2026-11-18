"use client";

import { Button } from "@heroui/react";
import { useEffect, useRef, useState } from "react";
import { FIELD_APP_LINKS, type FieldAppLink } from "../../config/app-links";

export type CopyStatus = "idle" | "copied" | "failed";

type ClipboardEnv = {
  clipboard?: { writeText?: (text: string) => Promise<void> } | null;
  document?: Document | null;
};

/** Hidden-textarea copy for browsers without the Clipboard API (e.g. plain http). */
function legacyCopy(text: string, doc: Document | null | undefined): boolean {
  if (!doc?.body || typeof doc.execCommand !== "function") return false;
  const area = doc.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.left = "0";
  area.style.opacity = "0";
  doc.body.appendChild(area);
  try {
    area.select();
    return doc.execCommand("copy");
  } catch {
    return false;
  } finally {
    doc.body.removeChild(area);
  }
}

/** Copies `text`: Clipboard API first, then the textarea fallback. */
export async function copyText(
  text: string,
  env: ClipboardEnv = {
    clipboard: typeof navigator === "undefined" ? null : navigator.clipboard,
    document: typeof document === "undefined" ? null : document,
  },
): Promise<boolean> {
  if (env.clipboard?.writeText) {
    try {
      await env.clipboard.writeText(text);
      return true;
    } catch {
      // Rejected (permissions, non-secure context): try the fallback.
    }
  }
  return legacyCopy(text, env.document);
}

function CopyIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      aria-hidden="true"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      data-icon="copy"
    >
      <rect x="7" y="7" width="10" height="10" rx="2" />
      <path d="M13 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      aria-hidden="true"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      data-icon="check"
    >
      <path d="M4 10.5l4 4 8-9" />
    </svg>
  );
}

export function CopyLinkButton({
  link,
  status,
  onCopy,
}: {
  link: FieldAppLink;
  status: CopyStatus;
  onCopy: () => void;
}) {
  const copied = status === "copied";
  return (
    <Button
      size="sm"
      variant="outline"
      aria-label={copied ? `${link.name} link copied` : `Copy ${link.name} link`}
      data-testid={`copy-${link.key}`}
      onPress={onCopy}
      className="min-w-24 shrink-0"
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      <span>{copied ? "Copied" : "Copy"}</span>
    </Button>
  );
}

export function AppLinkRow({
  link,
  status: initial = "idle",
}: {
  link: FieldAppLink;
  status?: CopyStatus;
}) {
  const [status, setStatus] = useState<CopyStatus>(initial);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function onCopy() {
    const ok = await copyText(link.url);
    setStatus(ok ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    if (ok) timer.current = setTimeout(() => setStatus("idle"), 2000);
  }

  return (
    <li className="grid gap-1" data-testid={`app-link-${link.key}`}>
      <div className="flex min-w-0 items-center gap-3">
        <div className="grid min-w-0 flex-1">
          <span className="text-sm font-medium text-foreground">
            {link.label}
          </span>
          <a
            href={link.url}
            title={link.url}
            target="_blank"
            rel="noopener noreferrer"
            className="truncate font-mono text-xs text-muted hover:text-accent"
          >
            {link.url}
          </a>
        </div>
        <a
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 text-sm font-medium text-accent"
        >
          Open
        </a>
        <CopyLinkButton
          link={link}
          status={status}
          onCopy={() => void onCopy()}
        />
      </div>
      <p className="text-xs leading-5 text-muted">{link.hint}</p>
      {status === "failed" ? (
        <p role="alert" className="text-xs text-danger">
          Couldn&rsquo;t copy, select the link instead.
        </p>
      ) : null}
      {status === "copied" ? (
        <span role="status" className="sr-only">
          Copied
        </span>
      ) : null}
    </li>
  );
}

/** The two Field app links, each with Open and Copy. */
export function AppLinkList() {
  return (
    <ul className="grid gap-3">
      {FIELD_APP_LINKS.map((link) => (
        <AppLinkRow key={link.key} link={link} />
      ))}
    </ul>
  );
}

/** Compact card for Setup > People. */
export function ShareFieldAppCard() {
  return (
    <section
      data-testid="share-field-app"
      className="grid gap-3 rounded-xl border border-border bg-surface p-4"
    >
      <h3 className="text-sm font-semibold text-foreground">
        Share the Field app
      </h3>
      <AppLinkList />
    </section>
  );
}
