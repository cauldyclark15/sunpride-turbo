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
 * A side panel over the page (a full-screen sheet on a phone, clear of the
 * notch and home bar). It always has a close button, and Escape closes it.
 */
export function Drawer({
  open,
  title,
  onClose,
  children,
  wide = false,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** 720px instead of 440px, for two-column forms. */
  wide?: boolean;
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
        className={`relative flex h-[100dvh] w-full flex-col overflow-hidden border-border bg-surface shadow-xl sm:h-auto sm:rounded-l-2xl sm:border ${wide ? "sm:w-[min(720px,100vw)]" : "sm:w-[440px]"}`}
      >
        <header className="flex items-center justify-between gap-3 border-b border-separator px-5 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] sm:py-4">
          <h2 className="text-[15px] font-semibold text-foreground">{title}</h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="inline-flex min-h-11 items-center rounded-lg border border-border px-4 text-[14px] font-medium text-foreground hover:bg-default-soft sm:h-8 sm:min-h-0 sm:px-3 sm:text-[13px]"
          >
            Close
          </button>
        </header>
        <div className="flex-1 overflow-y-auto overscroll-contain px-5 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:flex-none">
          {children}
        </div>
      </aside>
    </div>
  );
}
