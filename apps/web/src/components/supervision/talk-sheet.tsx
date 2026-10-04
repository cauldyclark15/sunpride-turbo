"use client";

import { Button } from "@heroui/react";
import { api } from "@sunpride/backend/api";
import type { Id } from "@sunpride/backend/data-model";
import {
  Card,
  DataTable,
  FormField,
  MetricCard,
  Notice,
  StatusPill,
  WorkspaceIcon,
  type DataColumn,
} from "@sunpride/ui";
import { useMutation, useQuery } from "convex/react";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { useState } from "react";
import { manilaToday, type SupervisionFilters } from "./supervision-model";
import {
  daysLabel,
  ITEM_STATUS_LABELS,
  itemTone,
  SHEET_STATUS_LABELS,
  sheetTone,
  TOPIC_LABELS,
  TOPICS,
  type ItemStatus,
} from "./talk-sheet-model";
import { shortDate } from "./work-with-model";

type Register = FunctionReturnType<typeof api.supervision.talk_sheet.register>;
type Chain = Register["chains"][number] & { id: string };
type OpenItem = Register["openItems"][number] & { id: string };
type Mine = FunctionReturnType<typeof api.supervision.talk_sheet.mine>;
type MineRow = Mine["sheets"][number] & { id: string };
type Detail = FunctionReturnType<typeof api.supervision.talk_sheet.detail>;
type SaveArgs = FunctionArgs<typeof api.supervision.talk_sheet.save>;
type ItemInput = NonNullable<SaveArgs["items"]>[number];
type SheetId = Id<"talkSheets">;

function errorText(error: unknown) {
  const data = (error as { data?: unknown })?.data;
  return typeof data === "string" ? data : "Not saved. Try again.";
}

const dateCell = (date: string | null) =>
  date ? <span className="font-mono text-[13px]">{shortDate(date)}</span> : "—";

/** Supervisor view: every partner chain in scope and the lines that carry forward. */
export function TalkSheetRegisterView({
  data,
  onOpen,
}: {
  data: Register;
  onOpen?: (id: SheetId) => void;
}) {
  const chains: Chain[] = data.chains.map((row) => ({
    ...row,
    id: row.latestSheetId,
  }));
  const items: OpenItem[] = data.openItems.map((row) => ({
    ...row,
    id: row.itemId,
  }));
  const overdue = items.filter((row) => row.status === "overdue").length;
  const rootCause = items.filter((row) => row.rootCauseDue).length;
  const chainColumns: DataColumn<Chain>[] = [
    {
      key: "partner",
      label: "Partner",
      render: (row) => (
        <span className="flex flex-col">
          <span className="text-sm font-medium text-foreground">
            {row.partnerName}
          </span>
          <span className="text-xs text-muted">
            {[row.ownerName, row.unitName].filter(Boolean).join(" · ")}
          </span>
        </span>
      ),
    },
    {
      key: "last",
      label: "Last signed",
      render: (row) => dateCell(row.lastMeetingDate),
    },
    {
      key: "next",
      label: "Next contact",
      render: (row) =>
        row.contactOverdue && row.nextContactDate ? (
          <StatusPill tone="danger">
            {`${shortDate(row.nextContactDate)} · missed`}
          </StatusPill>
        ) : row.draftSheetId ? (
          <StatusPill tone="warning">Draft open</StatusPill>
        ) : (
          dateCell(row.nextContactDate)
        ),
    },
    {
      key: "open",
      label: "Open",
      align: "right",
      render: (row) => (row.openCount ? row.openCount : "—"),
    },
    {
      key: "overdue",
      label: "Overdue",
      align: "right",
      render: (row) =>
        row.overdueCount ? (
          <StatusPill tone="danger">{String(row.overdueCount)}</StatusPill>
        ) : (
          "—"
        ),
    },
    {
      key: "action",
      label: "",
      align: "right",
      render: (row) =>
        onOpen ? (
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            aria-label={`Open Talk Sheet with ${row.partnerName}`}
            onPress={() => onOpen(row.latestSheetId)}
          >
            Open
          </Button>
        ) : null,
    },
  ];
  const itemColumns: DataColumn<OpenItem>[] = [
    {
      key: "issue",
      label: "Gap or issue",
      render: (row) => (
        <span className="flex flex-col">
          <span className="text-sm text-foreground">{row.gap}</span>
          <span className="text-xs text-muted">
            {[row.partnerName, TOPIC_LABELS[row.topic]].join(" · ")}
          </span>
        </span>
      ),
    },
    {
      key: "responsible",
      label: "Responsible",
      render: (row) => row.responsible,
    },
    {
      key: "timeline",
      label: "Timeline",
      render: (row) => dateCell(row.timeline || null),
    },
    {
      key: "age",
      label: "Open for",
      align: "right",
      render: (row) =>
        row.rootCauseDue ? (
          <StatusPill tone="danger">
            {`${daysLabel(row.daysOpen)} · root cause`}
          </StatusPill>
        ) : (
          daysLabel(row.daysOpen)
        ),
    },
    {
      key: "status",
      label: "Status",
      align: "right",
      render: (row) => (
        <StatusPill tone={itemTone(row.status)}>
          {ITEM_STATUS_LABELS[row.status]}
        </StatusPill>
      ),
    },
  ];
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <MetricCard
          label="Open items"
          value={String(items.length)}
          detail="carry to the next Talk Sheet"
        />
        <MetricCard
          label="Overdue"
          value={String(overdue)}
          detail="past their timeline"
        />
        <MetricCard
          label="Root-cause review"
          value={String(rootCause)}
          detail="open over a month"
        />
      </div>
      {data.truncated && (
        <p className="text-[13px] text-muted">Partial list. Pick a unit.</p>
      )}
      <Card
        label="Partners"
        count={chains.length}
        icon={<WorkspaceIcon name="user" />}
        flush
      >
        {chains.length ? (
          <DataTable rows={chains} columns={chainColumns} bare empty={null} />
        ) : (
          <p className="p-4 text-[13px] text-muted">No Talk Sheets here yet</p>
        )}
      </Card>
      <Card
        label="Open items"
        count={items.length}
        icon={<WorkspaceIcon name="list" />}
        flush
      >
        {items.length ? (
          <DataTable rows={items} columns={itemColumns} bare empty={null} />
        ) : (
          <p className="p-4 text-[13px] text-muted">Nothing open</p>
        )}
      </Card>
    </div>
  );
}

const blankItem = (meetingDate: string): ItemInput => ({
  topic: "siv_stt",
  gap: "",
  agreement: "",
  correctiveAction: "",
  responsible: "",
  timeline: meetingDate,
  status: "on_going",
});

function Field({
  label,
  value,
  onChange,
  disabled,
  multiline = false,
  max = 2000,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  multiline?: boolean;
  max?: number;
}) {
  return (
    <FormField label={label}>
      {multiline ? (
        <textarea
          aria-label={label}
          rows={2}
          maxLength={max}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          aria-label={label}
          className="h-10"
          maxLength={max}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </FormField>
  );
}

/** The author's form for one sheet; read-only for everybody else. */
export function TalkSheetEditorView({
  detail,
  save,
  finalize,
  discard,
  onClose,
}: {
  detail: Detail;
  save: (args: SaveArgs) => Promise<null>;
  finalize: (args: { sheetId: SheetId }) => Promise<null>;
  discard: (args: { sheetId: SheetId }) => Promise<null>;
  onClose: () => void;
}) {
  const { sheet } = detail;
  const disabled = !detail.canEdit;
  const views = new Map(detail.items.map((row) => [row.item._id, row]));
  const [items, setItems] = useState<ItemInput[]>(() =>
    detail.items.map(({ item }) => ({
      itemId: item._id,
      topic: item.topic,
      gap: item.gap,
      agreement: item.agreement,
      correctiveAction: item.correctiveAction,
      responsible: item.responsible,
      timeline: item.timeline,
      status: item.status,
      ...(item.rootCause ? { rootCause: item.rootCause } : {}),
    })),
  );
  const [acknowledged, setAcknowledged] = useState(
    sheet.acknowledgedByName ?? "",
  );
  const [nextContact, setNextContact] = useState(sheet.nextContactDate ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const payload = (): SaveArgs => ({
    sheetId: sheet._id,
    acknowledgedByName: acknowledged,
    nextContactDate: nextContact,
    items,
  });
  async function run(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    setMessage("");
    try {
      await action();
      setMessage(done);
    } catch (caught) {
      setMessage(errorText(caught));
    } finally {
      setBusy(false);
    }
  }
  const setItem = (index: number, patch: Partial<ItemInput>) =>
    setItems((rows) =>
      rows.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );

  return (
    <Card
      label={`Talk Sheet · ${sheet.partnerName} · ${shortDate(sheet.meetingDate)}`}
      icon={<WorkspaceIcon name="list" />}
      actions={
        <Button size="sm" variant="ghost" className="h-8" onPress={onClose}>
          Close
        </Button>
      }
    >
      <div className="grid gap-4">
        <p className="text-[13px] text-muted">
          {[
            `Discussed by ${detail.ownerName}`,
            detail.previousMeetingDate
              ? `Carried from ${shortDate(detail.previousMeetingDate)}`
              : "First Talk Sheet with this partner",
          ].join(" · ")}{" "}
          <StatusPill tone={sheetTone(sheet.status)}>
            {SHEET_STATUS_LABELS[sheet.status] ?? sheet.status}
          </StatusPill>
        </p>
        {detail.gaps.length > 0 && (
          <Notice
            title="Still needed to sign off"
            meta={
              <ul className="list-disc pl-4">
                {detail.gaps.map((gap) => (
                  <li key={gap.code}>{gap.label}</li>
                ))}
              </ul>
            }
          />
        )}
        <p className="text-[12px] text-muted">
          On-going and Overdue items carry to the next Talk Sheet. An item
          closes only when Completed.
        </p>

        <section aria-label="Gaps and issues" className="grid gap-3">
          {items.map((row, index) => {
            const view = row.itemId ? views.get(row.itemId) : undefined;
            const carried = !!view?.carried;
            const status: ItemStatus = view
              ? view.effectiveStatus
              : (row.status as ItemStatus);
            return (
              <div
                key={row.itemId ?? `new-${index}`}
                className="grid gap-2 rounded-[10px] border border-border p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    aria-label={`Line ${index + 1} topic`}
                    className="h-9 w-[220px]"
                    value={row.topic}
                    disabled={disabled || carried}
                    onChange={(event) =>
                      setItem(index, {
                        topic: event.target.value as ItemInput["topic"],
                      })
                    }
                  >
                    {TOPICS.map(([code, label]) => (
                      <option key={code} value={code}>
                        {label}
                      </option>
                    ))}
                  </select>
                  {carried && view && (
                    <span className="text-[12px] text-muted">
                      {`Carried · raised ${shortDate(view.item.openedOn)} · open ${daysLabel(view.daysOpen)}`}
                    </span>
                  )}
                  <StatusPill tone={itemTone(status)}>
                    {ITEM_STATUS_LABELS[status]}
                  </StatusPill>
                  {view?.rootCauseDue && (
                    <StatusPill tone="danger">Root-cause review</StatusPill>
                  )}
                  {!disabled && !carried && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8"
                      aria-label={`Remove line ${index + 1}`}
                      onPress={() =>
                        setItems((rows) => rows.filter((_, i) => i !== index))
                      }
                    >
                      Remove
                    </Button>
                  )}
                </div>
                <Field
                  label={`Line ${index + 1} gap or issue`}
                  value={row.gap}
                  disabled={disabled || carried}
                  multiline
                  onChange={(gap) => setItem(index, { gap })}
                />
                <div className="grid gap-2 sm:grid-cols-2">
                  <Field
                    label={`Line ${index + 1} agreement`}
                    value={row.agreement}
                    disabled={disabled}
                    multiline
                    onChange={(agreement) => setItem(index, { agreement })}
                  />
                  <Field
                    label={`Line ${index + 1} corrective action`}
                    value={row.correctiveAction}
                    disabled={disabled}
                    multiline
                    onChange={(correctiveAction) =>
                      setItem(index, { correctiveAction })
                    }
                  />
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <div className="w-[220px] max-w-full">
                    <Field
                      label={`Line ${index + 1} responsible`}
                      value={row.responsible}
                      disabled={disabled}
                      max={120}
                      onChange={(responsible) =>
                        setItem(index, { responsible })
                      }
                    />
                  </div>
                  <div className="w-[160px] max-w-full">
                    <FormField label="Timeline">
                      <input
                        type="date"
                        aria-label={`Line ${index + 1} timeline`}
                        className="h-10"
                        value={row.timeline}
                        disabled={disabled}
                        onChange={(event) =>
                          setItem(index, { timeline: event.target.value })
                        }
                      />
                    </FormField>
                  </div>
                  <div className="w-[160px] max-w-full">
                    <FormField label="Status">
                      <select
                        aria-label={`Line ${index + 1} status`}
                        className="h-10"
                        value={row.status}
                        disabled={disabled}
                        onChange={(event) =>
                          setItem(index, {
                            status: event.target.value as ItemStatus,
                          })
                        }
                      >
                        {Object.entries(ITEM_STATUS_LABELS).map(
                          ([code, label]) => (
                            <option key={code} value={code}>
                              {label}
                            </option>
                          ),
                        )}
                      </select>
                    </FormField>
                  </div>
                </div>
                {(view?.rootCauseDue || row.rootCause) && (
                  <Field
                    label={`Line ${index + 1} root-cause review`}
                    value={row.rootCause ?? ""}
                    disabled={disabled}
                    multiline
                    onChange={(rootCause) => setItem(index, { rootCause })}
                  />
                )}
              </div>
            );
          })}
          {!disabled && (
            <div>
              <Button
                size="sm"
                variant="outline"
                className="h-9"
                isDisabled={items.length >= 40}
                onPress={() =>
                  setItems((rows) => [...rows, blankItem(sheet.meetingDate)])
                }
              >
                Add gap or issue
              </Button>
            </div>
          )}
        </section>

        <div className="flex flex-wrap items-end gap-3">
          <div className="w-[260px] max-w-full">
            <Field
              label="Acknowledged and committed by"
              value={acknowledged}
              disabled={disabled}
              max={120}
              onChange={setAcknowledged}
            />
          </div>
          <div className="w-[180px] max-w-full">
            <FormField label="Next contact">
              <input
                type="date"
                aria-label="Next contact date"
                className="h-10"
                value={nextContact}
                disabled={disabled}
                onChange={(event) => setNextContact(event.target.value)}
              />
            </FormField>
          </div>
        </div>

        {detail.canEdit && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              className="h-10"
              isPending={busy}
              onPress={() => void run(() => save(payload()), "Saved")}
            >
              Save
            </Button>
            <Button
              variant="primary"
              className="h-10"
              isPending={busy}
              onPress={() =>
                void run(async () => {
                  await save(payload());
                  await finalize({ sheetId: sheet._id });
                }, "Signed off")
              }
            >
              Save and sign off
            </Button>
            <Button
              variant="ghost"
              className="h-10"
              isPending={busy}
              onPress={() =>
                void run(async () => {
                  await discard({ sheetId: sheet._id });
                  onClose();
                }, "Discarded")
              }
            >
              Discard draft
            </Button>
          </div>
        )}
        {message && (
          <span role="status" className="text-[13px] text-muted">
            {message}
          </span>
        )}
      </div>
    </Card>
  );
}

function SheetEditor({
  sheetId,
  onClose,
}: {
  sheetId: SheetId;
  onClose: () => void;
}) {
  const detail = useQuery(api.supervision.talk_sheet.detail, { sheetId });
  const save = useMutation(api.supervision.talk_sheet.save);
  const finalize = useMutation(api.supervision.talk_sheet.finalize);
  const discard = useMutation(api.supervision.talk_sheet.discard);
  if (detail === undefined)
    return <span className="text-[13px] text-muted">Loading Talk Sheet…</span>;
  return (
    <TalkSheetEditorView
      // Re-seed the form when the sheet is signed off elsewhere.
      key={`${sheetId}-${detail.sheet.status}`}
      detail={detail}
      save={save}
      finalize={finalize}
      discard={discard}
      onClose={onClose}
    />
  );
}

/** The author's own sheets and the form to start the next one with a partner. */
export function MyTalkSheetsView({
  mine,
  create,
  onOpen,
}: {
  mine: Mine;
  create: (args: {
    partnerName: string;
    meetingDate: string;
  }) => Promise<SheetId>;
  onOpen: (id: SheetId) => void;
}) {
  const [partner, setPartner] = useState("");
  const [date, setDate] = useState(() => manilaToday());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const rows: MineRow[] = mine.sheets.map((row) => ({
    ...row,
    id: row.sheetId,
  }));
  async function submit() {
    setBusy(true);
    setError("");
    try {
      onOpen(await create({ partnerName: partner, meetingDate: date }));
      setPartner("");
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }
  const columns: DataColumn<MineRow>[] = [
    {
      key: "date",
      label: "Meeting",
      render: (row) => dateCell(row.meetingDate),
    },
    { key: "partner", label: "Partner", render: (row) => row.partnerName },
    {
      key: "carried",
      label: "Carried from",
      render: (row) => dateCell(row.carriedFrom),
    },
    {
      key: "status",
      label: "Status",
      align: "right",
      render: (row) => (
        <span className="flex items-center justify-end gap-2">
          <StatusPill tone={sheetTone(row.status)}>
            {SHEET_STATUS_LABELS[row.status] ?? row.status}
          </StatusPill>
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            aria-label={`Open Talk Sheet with ${row.partnerName} on ${row.meetingDate}`}
            onPress={() => onOpen(row.sheetId)}
          >
            Open
          </Button>
        </span>
      ),
    },
  ];
  return (
    <Card
      label="My Talk Sheets"
      count={rows.length}
      icon={<WorkspaceIcon name="plus" />}
    >
      <div className="grid gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-[240px] max-w-full">
            <FormField label="Partner">
              <input
                aria-label="Partner"
                className="h-10"
                list="talk-sheet-partners"
                maxLength={120}
                value={partner}
                onChange={(event) => setPartner(event.target.value)}
              />
              <datalist id="talk-sheet-partners">
                {mine.partners.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </FormField>
          </div>
          <div className="w-[160px] max-w-full">
            <FormField label="Meeting date">
              <input
                type="date"
                aria-label="Meeting date"
                className="h-10"
                value={date}
                onChange={(event) => setDate(event.target.value)}
              />
            </FormField>
          </div>
          <Button
            variant="primary"
            className="h-10"
            isDisabled={!partner.trim() || !date}
            isPending={busy}
            onPress={() => void submit()}
          >
            Start Talk Sheet
          </Button>
          {error && (
            <span role="alert" className="text-[12px] text-danger">
              {error}
            </span>
          )}
        </div>
        {rows.length > 0 && (
          <DataTable rows={rows} columns={columns} empty={null} />
        )}
      </div>
    </Card>
  );
}

function MyTalkSheets({ onOpen }: { onOpen: (id: SheetId) => void }) {
  const mine = useQuery(api.supervision.talk_sheet.mine, {});
  const create = useMutation(api.supervision.talk_sheet.create);
  if (mine === undefined)
    return (
      <span className="text-[13px] text-muted">Loading your Talk Sheets…</span>
    );
  return <MyTalkSheetsView mine={mine} create={create} onOpen={onOpen} />;
}

function Register({
  filters,
  onOpen,
}: {
  filters: SupervisionFilters;
  onOpen: (id: SheetId) => void;
}) {
  const data = useQuery(api.supervision.talk_sheet.register, filters);
  if (data === undefined)
    return <span className="text-[13px] text-muted">Loading Talk Sheets…</span>;
  return <TalkSheetRegisterView data={data} onOpen={onOpen} />;
}

export function TalkSheet({ filters }: { filters: SupervisionFilters }) {
  const permissions = useQuery(api.lib.capabilities.currentPermissions, {});
  const [open, setOpen] = useState<SheetId | null>(null);
  const capabilities = permissions?.capabilities ?? [];
  const canRecord = capabilities.includes("visit.record");
  const canSupervise =
    capabilities.includes("people.read") && capabilities.includes("visit.read");
  return (
    <div className="grid gap-4">
      {open && <SheetEditor sheetId={open} onClose={() => setOpen(null)} />}
      {canRecord && <MyTalkSheets onOpen={setOpen} />}
      {canSupervise && <Register filters={filters} onOpen={setOpen} />}
    </div>
  );
}
