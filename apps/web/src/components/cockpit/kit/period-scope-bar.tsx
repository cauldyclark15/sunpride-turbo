"use client";

import { PHONE_ACTIONS_ID, WorkspaceIcon } from "@sunpride/ui";
import { useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useUnits } from "../api";
import {
  addDays,
  channelLabel,
  CHANNELS,
  effectiveRange,
  isIsoDate,
  manilaToday,
  PERIOD_PRESETS,
  presetOf,
  presetRange,
  readCommon,
} from "../period";
import { useUrlState } from "../use-url-state";
import { formatDate, formatDateRange } from "../format";
import { Drawer } from "./drawer";

const segmentBar =
  "h-9 whitespace-nowrap rounded-md px-2.5 text-[13px] font-medium transition-colors sm:h-8";
const segmentSheet =
  "min-h-11 whitespace-nowrap rounded-md px-3 text-[15px] font-medium transition-colors";
const segmentOn = "bg-foreground text-background";
const segmentOff = "text-muted hover:text-foreground";
const selectBar =
  "!min-h-9 h-9 w-full min-w-0 !rounded-lg !text-[13px] sm:!min-h-8 sm:h-8 sm:w-auto sm:max-w-[15rem]";
/** Phone sheet: 44 px targets, 16 px text so iOS does not zoom into the field. */
const selectSheet = "!min-h-11 h-11 w-full min-w-0 !rounded-lg !text-[16px]";
const dateBar =
  "!min-h-9 h-9 !rounded-lg !px-2 !text-[13px] sm:!min-h-8 sm:h-8";
const dateSheet =
  "!min-h-11 h-11 min-w-0 flex-1 !rounded-lg !px-2 !text-[16px]";

const noSubscription = () => () => {};

/** Drill and paging state that a new period or scope makes meaningless. */
const RESET = { parent: null, crumb: null, cursor: null } as const;

type BarProps = {
  mode?: "range" | "day";
  showChannel?: boolean;
  showCompare?: boolean;
  scopeLabel?: string;
};

/** "Today · Everything I can see" — the current choice in words, for the phone button. */
export function filterSummary(
  params: URLSearchParams,
  today: string,
  {
    mode = "range",
    scopeLabel,
    unitLabel,
  }: { mode?: "range" | "day"; scopeLabel?: string; unitLabel?: string },
) {
  const common = readCommon(params);
  let period: string;
  if (mode === "day") {
    const day = isIsoDate(params.get("date")) ? params.get("date")! : today;
    period =
      day === today
        ? "Today"
        : day === addDays(today, -1)
          ? "Yesterday"
          : formatDate(day);
  } else {
    const range = effectiveRange(common, today);
    const preset = presetOf(range.from, range.to, today);
    period =
      PERIOD_PRESETS.find((item) => item.id === preset)?.label ??
      formatDateRange(range.from, range.to);
  }
  const area = common.unitId
    ? (unitLabel ?? "One area")
    : (scopeLabel ?? "Everything I can see");
  const parts = [period, area];
  if (common.channel) parts.push(channelLabel(common.channel));
  return {
    period,
    area: parts.slice(1).join(" · "),
    text: parts.join(" · "),
  };
}

/**
 * The one period/scope bar on every cockpit page. Everything lives in the URL
 * (`from`, `to`, `unitId`, `channel`, `compare`; `date` on day pages). On
 * phones and tablets it folds into one "Filters" button (plus a short chip in
 * the top bar) that opens a bottom sheet with the same controls.
 */
export function PeriodScopeBar(props: BarProps) {
  const { params } = useUrlState();
  const today = manilaToday();
  const units = useUnits(true);
  const [open, setOpen] = useState(false);
  // undefined on the server and during hydration, so no button renders
  // inline and then jumps into the top bar a moment later.
  const slot = useSyncExternalStore(
    noSubscription,
    () => document.getElementById(PHONE_ACTIONS_ID),
    () => undefined,
  );
  const unitId = params.get("unitId");
  const summary = filterSummary(params, today, {
    mode: props.mode,
    scopeLabel: props.scopeLabel,
    unitLabel: units.data?.find((unit) => unit.id === unitId)?.label,
  });

  return (
    <>
      <div className="max-lg:hidden">
        <BarControls {...props} />
      </div>
      {slot ? (
        createPortal(
          <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-label={`Filters: ${summary.text}`}
            data-filters-button="top"
            onClick={() => setOpen(true)}
            className="ck-noprint flex min-h-11 max-w-[10.5rem] items-center gap-2 rounded-lg border border-border bg-surface-secondary/60 py-1 pl-2.5 pr-3 text-left"
          >
            <WorkspaceIcon
              name="filters"
              className="size-4 shrink-0 text-muted"
            />
            <span className="grid min-w-0 leading-tight">
              <span className="truncate text-[13px] font-semibold text-foreground">
                {summary.period}
              </span>
              <span className="truncate text-[11.5px] text-muted">
                {summary.area}
              </span>
            </span>
          </button>,
          slot,
        )
      ) : slot === null ? (
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          data-filters-button="inline"
          onClick={() => setOpen(true)}
          className="ck-noprint flex min-h-11 w-full min-w-0 items-center gap-2.5 rounded-xl border border-border bg-surface-secondary/60 px-3 text-left lg:hidden"
        >
          <WorkspaceIcon
            name="filters"
            className="size-4 shrink-0 text-muted"
          />
          <span className="shrink-0 text-[13px] font-semibold text-foreground">
            Filters
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] text-muted">
            {summary.text}
          </span>
        </button>
      ) : null}
      {open ? (
        <Drawer open title="Filters" onClose={() => setOpen(false)}>
          <BarControls {...props} sheet />
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="mt-4 min-h-11 w-full rounded-lg bg-foreground text-[15px] font-semibold text-background"
          >
            Show figures
          </button>
        </Drawer>
      ) : null}
    </>
  );
}

function BarControls({
  mode = "range",
  showChannel = true,
  showCompare = true,
  scopeLabel,
  sheet = false,
}: BarProps & { sheet?: boolean }) {
  const segment = sheet ? segmentSheet : segmentBar;
  const select = sheet ? selectSheet : selectBar;
  const dateInput = sheet ? dateSheet : dateBar;
  const { params, set } = useUrlState();
  const today = manilaToday();
  const common = readCommon(params);
  const range = effectiveRange(common, today);
  const preset = presetOf(range.from, range.to, today);
  const [customOpen, setCustomOpen] = useState(preset === "custom");
  const units = useUnits(true);
  const day = isIsoDate(params.get("date")) ? params.get("date")! : today;

  return (
    <div
      role="toolbar"
      aria-label="Period and scope"
      className={
        sheet
          ? "ck-noprint flex flex-col gap-3"
          : "ck-bar ck-noprint flex flex-col gap-2 rounded-2xl border border-border bg-surface-secondary/60 p-2 lg:flex-row lg:flex-wrap lg:items-center"
      }
    >
      {mode === "range" ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label="Period"
            className={
              sheet
                ? "grid grid-cols-2 gap-1 rounded-lg border border-border bg-surface p-1"
                : "ck-scroll-x flex max-w-full gap-0.5 overflow-x-auto rounded-lg border border-border bg-surface p-0.5"
            }
          >
            {PERIOD_PRESETS.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={preset === item.id && !customOpen}
                className={`${segment} ${preset === item.id && !customOpen ? segmentOn : segmentOff}`}
                onClick={() => {
                  setCustomOpen(false);
                  set({ ...presetRange(item.id, today), ...RESET });
                }}
              >
                {item.label}
              </button>
            ))}
            <button
              type="button"
              aria-pressed={customOpen || preset === "custom"}
              className={`${segment} ${customOpen || preset === "custom" ? segmentOn : segmentOff}`}
              onClick={() => setCustomOpen(true)}
            >
              Custom
            </button>
          </div>
          {customOpen || preset === "custom" ? (
            <div className="flex items-center gap-1.5 text-[13px] text-muted">
              <input
                type="date"
                aria-label="From"
                value={range.from}
                max={range.to}
                className={dateInput}
                onChange={(event) =>
                  isIsoDate(event.target.value) &&
                  set({ from: event.target.value, to: range.to, ...RESET })
                }
              />
              <span>to</span>
              <input
                type="date"
                aria-label="To"
                value={range.to}
                min={range.from}
                className={dateInput}
                onChange={(event) =>
                  isIsoDate(event.target.value) &&
                  set({ from: range.from, to: event.target.value, ...RESET })
                }
              />
            </div>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label="Day"
            className="flex gap-0.5 rounded-lg border border-border bg-surface p-0.5"
          >
            {[
              { label: "Today", date: today },
              { label: "Yesterday", date: addDays(today, -1) },
            ].map((item) => (
              <button
                key={item.label}
                type="button"
                aria-pressed={day === item.date}
                className={`${segment} ${day === item.date ? segmentOn : segmentOff}`}
                onClick={() =>
                  set({ date: item.date === today ? null : item.date })
                }
              >
                {item.label}
              </button>
            ))}
          </div>
          <input
            type="date"
            aria-label="Day"
            value={day}
            max={today}
            className={dateInput}
            onChange={(event) =>
              isIsoDate(event.target.value) &&
              set({
                date: event.target.value === today ? null : event.target.value,
              })
            }
          />
        </div>
      )}

      <div
        className={
          sheet
            ? "grid grid-cols-1 gap-3"
            : "grid grid-cols-1 gap-2 sm:flex sm:flex-wrap sm:items-center lg:ml-auto"
        }
      >
        {units.data && units.data.length ? (
          <select
            aria-label="Area"
            className={select}
            value={common.unitId ?? ""}
            onChange={(event) =>
              set({ unitId: event.target.value || null, ...RESET })
            }
          >
            <option value="">{scopeLabel ?? "Everything I can see"}</option>
            {units.data
              .filter((unit) => unit.label !== scopeLabel)
              .map((unit) => (
                <option key={unit.id} value={unit.id}>
                  {`${"\u2002".repeat(unit.depth)}${unit.label}`}
                </option>
              ))}
          </select>
        ) : scopeLabel ? (
          <span className="inline-flex h-8 items-center truncate rounded-lg border border-border bg-surface px-3 text-[13px] text-foreground">
            {scopeLabel}
          </span>
        ) : null}
        {showChannel ? (
          <select
            aria-label="Channel"
            className={select}
            value={common.channel ?? ""}
            onChange={(event) =>
              set({ channel: event.target.value || null, ...RESET })
            }
          >
            <option value="">All channels</option>
            {CHANNELS.map((channel) => (
              <option key={channel.key} value={channel.key}>
                {channel.label}
              </option>
            ))}
          </select>
        ) : null}
        {mode === "range" && showCompare ? (
          <div
            role="group"
            aria-label="Compare with"
            className="flex gap-0.5 rounded-lg border border-border bg-surface p-0.5"
          >
            {[
              { id: "prior", label: "vs prior period" },
              { id: "ly", label: "vs last year" },
            ].map((item) => {
              const on = (common.compare ?? "prior") === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={on}
                  className={`${segment} flex-1 ${on ? segmentOn : segmentOff}`}
                  onClick={() =>
                    set({ compare: item.id === "prior" ? null : item.id })
                  }
                >
                  {item.label}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
