"use client";

import { useEffect, useRef, type ReactNode } from "react";

/** Closes on Escape; returns true when it handled the key. */
export function closeOnEscape(
  event: Pick<KeyboardEvent, "key" | "defaultPrevented">,
  onClose: () => void,
): boolean {
  if (event.key !== "Escape" || event.defaultPrevented) return false;
  onClose();
  return true;
}

/**
 * A side panel over the page (a bottom sheet on a phone). It always has a
 * close button, and Escape closes it.
 */
export function Drawer({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => closeOnEscape(event, onClose);
    window.addEventListener("keydown", handler);
    closeRef.current?.focus();
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="ck-noprint fixed inset-0 z-50 flex items-end justify-end sm:items-stretch">
      <button
        type="button"
        aria-label="Close panel"
        tabIndex={-1}
        className="absolute inset-0 bg-black/20"
        onClick={onClose}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative flex max-h-[85svh] w-full flex-col overflow-hidden rounded-t-2xl border border-border bg-surface shadow-xl sm:max-h-none sm:w-[440px] sm:rounded-none sm:rounded-l-2xl"
      >
        <header className="flex items-center justify-between gap-3 border-b border-separator px-5 py-4">
          <h2 className="text-[15px] font-semibold text-foreground">{title}</h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="inline-flex h-8 items-center rounded-lg border border-border px-3 text-[13px] font-medium text-foreground hover:bg-default-soft"
          >
            Close
          </button>
        </header>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
      </aside>
    </div>
  );
}
