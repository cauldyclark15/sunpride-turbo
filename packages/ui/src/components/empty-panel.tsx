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
  description: string;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <EmptyState className="min-h-64 rounded-lg border border-dashed border-border bg-surface shadow-none">
      <EmptyState.Header>
        {icon ? (
          <EmptyState.Media variant="icon">{icon}</EmptyState.Media>
        ) : null}
        <EmptyState.Title>{title}</EmptyState.Title>
        <EmptyState.Description>{description}</EmptyState.Description>
      </EmptyState.Header>
      {action ? <EmptyState.Content>{action}</EmptyState.Content> : null}
    </EmptyState>
  );
}
