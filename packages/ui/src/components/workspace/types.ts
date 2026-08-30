import type { ReactNode } from "react";
import type { WorkspaceIconName } from "./workspace-icon";

export type WorkspaceNavItem = {
  id: string;
  label: string;
  href: string;
  icon: WorkspaceIconName;
  badge?: ReactNode;
};

export type WorkspaceNavGroup = {
  id: string;
  label?: string;
  items: WorkspaceNavItem[];
};

export type WorkspaceModuleTab = {
  id: string;
  label: string;
  href: string;
  badge?: ReactNode;
};

export type WorkspaceUser = {
  name: string;
  role: string;
};

export type WorkspaceBrand = {
  logo: ReactNode;
  name: string;
  descriptor: string;
};
