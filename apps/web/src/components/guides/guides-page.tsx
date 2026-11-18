"use client";

import Link from "next/link";
import { useState } from "react";
import {
  GUIDE_GROUPS,
  absoluteGuideUrl,
  downloadName,
  type Guide,
} from "../../config/guides";

/**
 * SP-0201: the Guides page. Every how-to grouped by who it is for; each with Open (new tab),
 * Download and a copy-link button that copies the full address on this website.
 */

type Clipboard = { writeText: (text: string) => Promise<void> };

/** Copies the guide's full address on `origin`; returns what was copied. */
export async function copyGuideLink(
  href: string,
  origin: string,
  clipboard: Clipboard | undefined,
  fallback?: (text: string) => boolean,
): Promise<string> {
  const url = absoluteGuideUrl(origin, href);
  try {
    if (!clipboard) throw new Error("no clipboard");
    await clipboard.writeText(url);
  } catch {
    // Older phone browsers, or a page that is not focused: the classic copy command still works.
    if (!fallback?.(url))
      throw new Error("Copy is not available in this browser.");
  }
  return url;
}

/** Copies through a hidden text box (document.execCommand), for browsers without the Clipboard API. */
function copyWithTextBox(text: string): boolean {
  const box = document.createElement("textarea");
  box.value = text;
  box.setAttribute("readonly", "");
  box.style.position = "fixed";
  box.style.opacity = "0";
  document.body.appendChild(box);
  box.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    box.remove();
  }
}

const buttonClass =
  "inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-border px-3 text-sm font-medium text-foreground hover:bg-default-soft";

function LinkIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-[18px] w-[18px] shrink-0"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1 1" />
      <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1-1" />
    </svg>
  );
}

function CopyLinkButton({ guide }: { guide: Guide }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  async function copy() {
    try {
      await copyGuideLink(
        guide.href,
        window.location.origin,
        navigator.clipboard,
        copyWithTextBox,
      );
      setState("copied");
    } catch {
      setState("failed");
    }
    window.setTimeout(() => setState("idle"), 2000);
  }
  const label =
    state === "copied"
      ? "Link copied"
      : state === "failed"
        ? "Could not copy"
        : `Copy link to ${guide.title}`;
  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={label}
      title={label}
      data-testid={`copy-${guide.id}`}
      className={`${buttonClass} w-9 px-0`}
    >
      {state === "copied" ? <span aria-hidden="true">✓</span> : <LinkIcon />}
    </button>
  );
}

function GuideRow({ guide }: { guide: Guide }) {
  return (
    <li className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="grid min-w-0 gap-0.5">
        <span className="text-[15px] font-semibold text-foreground">
          {guide.title}
        </span>
        <span className="text-sm text-muted">{guide.line}</span>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        <a
          href={guide.href}
          target="_blank"
          rel="noopener"
          className={buttonClass}
        >
          Open
        </a>
        <a
          href={guide.href}
          download={downloadName(guide.href)}
          className={buttonClass}
        >
          Download
        </a>
        <CopyLinkButton guide={guide} />
      </div>
    </li>
  );
}

export function GuidesPage() {
  return (
    <div className="grid max-w-4xl gap-8">
      <header className="grid gap-1">
        <h1 className="text-[26px] font-semibold tracking-tight text-foreground">
          Guides
        </h1>
        <p className="text-sm text-muted">
          Every how-to in one place. Open a guide, download it, or copy its link
          to send over Viber or email. Anyone with the link can open it.
        </p>
      </header>
      {GUIDE_GROUPS.map((group) => (
        <section
          key={group.id}
          id={group.id}
          aria-labelledby={`guides-${group.id}`}
          className="grid gap-1"
        >
          <h2
            id={`guides-${group.id}`}
            className="text-[17px] font-semibold text-foreground"
          >
            {group.title}
          </h2>
          <ul className="divide-y divide-border border-y border-border">
            {group.guides.map((guide) => (
              <GuideRow key={`${group.id}-${guide.id}`} guide={guide} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** A link the Help page (or anywhere) can drop in to reach the Guides page. */
export function GuidesLink({ className }: { className?: string }) {
  return (
    <Link href="/guides" className={className ?? "font-medium underline"}>
      All guides and how-tos
    </Link>
  );
}
