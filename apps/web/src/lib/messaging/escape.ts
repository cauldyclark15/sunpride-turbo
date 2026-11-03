"use client";

import { useEffect, useRef } from "react";

type Closer = { close: () => void };

/**
 * Escape closes the panel opened last (a lightbox over a thread closes
 * first, then the thread). One keydown listener per target serves the stack.
 */
export class EscapeStack {
  private entries: Closer[] = [];
  private detach: (() => void) | undefined;

  constructor(private readonly target: () => EventTarget | undefined) {}

  push(close: () => void): () => void {
    const entry: Closer = { close };
    this.entries.push(entry);
    this.attach();
    return () => {
      this.entries = this.entries.filter((item) => item !== entry);
      if (!this.entries.length) {
        this.detach?.();
        this.detach = undefined;
      }
    };
  }

  size() {
    return this.entries.length;
  }

  private attach() {
    if (this.detach) return;
    const target = this.target();
    if (!target) return;
    const listener = (event: Event) => {
      const key = (event as KeyboardEvent).key;
      if (key !== "Escape" && key !== "Esc") return;
      const top = this.entries.at(-1);
      if (!top) return;
      if ((event as KeyboardEvent).isComposing) return;
      event.preventDefault?.();
      event.stopPropagation?.();
      top.close();
    };
    target.addEventListener("keydown", listener);
    this.detach = () => target.removeEventListener("keydown", listener);
  }
}

const documentStack = new EscapeStack(() =>
  typeof document === "undefined" ? undefined : document,
);

/** Closes this panel on Escape while `active`. */
export function useEscape(onClose: () => void, active = true) {
  const latest = useRef(onClose);
  useEffect(() => {
    latest.current = onClose;
  });
  useEffect(() => {
    if (!active) return;
    return documentStack.push(() => latest.current());
  }, [active]);
}
