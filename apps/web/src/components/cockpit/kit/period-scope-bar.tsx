"use client";

import { useState } from "react";
import { useUnits } from "../api";
import {
  addDays,
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

const segment =
  "h-9 whitespace-nowrap rounded-md px-2.5 text-[13px] font-medium transition-colors sm:h-8";
const segmentOn = "bg-foreground text-background";
const segmentOff = "text-muted hover:text-foreground";
const select =
  "!min-h-9 h-9 w-full min-w-0 !rounded-lg !text-[13px] sm:!min-h-8 sm:h-8 sm:w-auto sm:max-w-[15rem]";

/** Drill and paging state that a new period or scope makes meaningless. */
const RESET = { parent: null, crumb: null, cursor: null } as const;

/**
 * The one period/scope bar on every cockpit page. Everything lives in the URL
 * (`from`, `to`, `unitId`, `channel`, `compare`; `date` on day pages).
 */
export function PeriodScopeBar({
  mode = "range",
  showChannel = true,
  showCompare = true,
  scopeLabel,
}: {
  mode?: "range" | "day";
  showChannel?: boolean;
  showCompare?: boolean;
  scopeLabel?: string;
}) {
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
      className="ck-bar ck-noprint flex flex-col gap-2 rounded-2xl border border-border bg-surface-secondary/60 p-2 lg:flex-row lg:flex-wrap lg:items-center"
    >
      {mode === "range" ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label="Period"
            className="ck-scroll-x flex max-w-full gap-0.5 overflow-x-auto rounded-lg border border-border bg-surface p-0.5"
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
                className="!min-h-9 h-9 !rounded-lg !px-2 !text-[13px] sm:!min-h-8 sm:h-8"
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
                className="!min-h-9 h-9 !rounded-lg !px-2 !text-[13px] sm:!min-h-8 sm:h-8"
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
            className="!min-h-9 h-9 !rounded-lg !px-2 !text-[13px] sm:!min-h-8 sm:h-8"
            onChange={(event) =>
              isIsoDate(event.target.value) &&
              set({
                date: event.target.value === today ? null : event.target.value,
              })
            }
          />
        </div>
      )}

      <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap sm:items-center lg:ml-auto">
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
