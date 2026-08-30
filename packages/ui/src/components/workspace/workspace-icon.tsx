import {
  ArrowRightFromSquare,
  ArrowsRotateRight,
  Boxes3,
  ChartColumn,
  CloudGear,
  Database,
  Gear,
  House,
  ListCheck,
  ListTimeline,
  Person,
  PersonsLock,
  PersonWorker,
  ShoppingBag,
  ShoppingCart,
  Signal,
} from "@gravity-ui/icons";

const icons = {
  admin: PersonsLock,
  approvals: ListCheck,
  catalog: Database,
  commercial: ShoppingCart,
  field: PersonWorker,
  home: House,
  inventory: Boxes3,
  logout: ArrowRightFromSquare,
  mobile: Signal,
  operations: Gear,
  order: ShoppingBag,
  queue: ListTimeline,
  reports: ChartColumn,
  sap: CloudGear,
  sync: ArrowsRotateRight,
  user: Person,
} as const;

export type WorkspaceIconName = keyof typeof icons;

export function WorkspaceIcon({
  name,
  className = "size-4",
}: {
  name: WorkspaceIconName;
  className?: string;
}) {
  const Icon = icons[name];
  return <Icon aria-hidden className={className} />;
}
