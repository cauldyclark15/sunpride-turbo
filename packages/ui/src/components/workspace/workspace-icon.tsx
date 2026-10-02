import {
  Archive,
  ArrowLeft,
  ArrowRightFromSquare,
  ArrowRotateLeft,
  ArrowsRotateRight,
  Boxes3,
  Bug,
  ChartColumn,
  CloudGear,
  Comment,
  Database,
  FileText,
  Gear,
  Grip,
  House,
  LayoutColumns3,
  ListCheck,
  ListTimeline,
  ListUl,
  Magnifier,
  Paperclip,
  Pencil,
  Person,
  PersonsLock,
  PersonWorker,
  Plus,
  ShoppingBag,
  ShoppingCart,
  Signal,
  TrashBin,
  Xmark,
} from "@gravity-ui/icons";

const icons = {
  admin: PersonsLock,
  approvals: ListCheck,
  archive: Archive,
  attachment: Paperclip,
  back: ArrowLeft,
  board: LayoutColumns3,
  bug: Bug,
  catalog: Database,
  close: Xmark,
  comment: Comment,
  commercial: ShoppingCart,
  document: FileText,
  edit: Pencil,
  field: PersonWorker,
  grip: Grip,
  home: House,
  inventory: Boxes3,
  issues: Bug,
  list: ListUl,
  logout: ArrowRightFromSquare,
  mobile: Signal,
  operations: Gear,
  order: ShoppingBag,
  plus: Plus,
  queue: ListTimeline,
  reports: ChartColumn,
  restore: ArrowRotateLeft,
  sap: CloudGear,
  search: Magnifier,
  sync: ArrowsRotateRight,
  trash: TrashBin,
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
