"use client";

import { Button } from "@heroui/react/button";
import type { WorkspaceModuleTab } from "./types";

export function WorkspaceModuleTabs({
  activeHref,
  items,
  onNavigate,
}: {
  activeHref: string;
  items: WorkspaceModuleTab[];
  onNavigate: (href: string) => void;
}) {
  if (items.length < 2) return null;

  return (
    <nav
      aria-label="Module sections"
      className="-mx-1 flex gap-1 overflow-x-auto border-b border-separator px-1"
    >
      {items.map((item) => {
        const isCurrent = activeHref === item.href;

        return (
          <Button
            key={item.id}
            aria-current={isCurrent ? "page" : undefined}
            variant="ghost"
            className={`relative min-w-max rounded-b-none rounded-t-md border-b-2 px-3 pb-2.5 pt-2 text-sm ${
              isCurrent
                ? "border-accent bg-transparent font-semibold text-foreground"
                : "border-transparent bg-transparent text-muted hover:text-foreground"
            }`}
            onPress={() => onNavigate(item.href)}
          >
            {item.label}
            {item.badge ? (
              <span className="rounded bg-default-soft px-1.5 py-0.5 text-[0.6875rem] text-default-soft-foreground">
                {item.badge}
              </span>
            ) : null}
          </Button>
        );
      })}
    </nav>
  );
}
