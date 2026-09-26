"use client";

import { EmptyState } from "@heroui-pro/react/empty-state";
import type { ReactNode } from "react";

export function EmptyPanel({
  title,
  description,
  icon,
  action,
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <EmptyState className="min-h-32 rounded-2xl border border-border bg-surface p-4 shadow-none">
      <EmptyState.Header>
        {icon ? (
          <EmptyState.Media variant="icon">{icon}</EmptyState.Media>
        ) : null}
        <EmptyState.Title>{title}</EmptyState.Title>
        {description ? (
          <EmptyState.Description>{description}</EmptyState.Description>
        ) : null}
      </EmptyState.Header>
      {action ? <EmptyState.Content>{action}</EmptyState.Content> : null}
    </EmptyState>
  );
}
