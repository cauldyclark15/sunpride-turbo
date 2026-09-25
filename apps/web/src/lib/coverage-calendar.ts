import { manilaDateToUtcMs } from "./manila-date";

/** Date-only Manila calendar: UTC methods operate on the local date's labels, never host-local time. */
export function coverageMonthDays(month: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
    throw new Error("Invalid coverage month");
  const first = manilaDateToUtcMs(`${month}-01`) + 8 * 3600000;
  const [year, ordinal] = month.split("-").map(Number);
  const length = new Date(Date.UTC(year!, ordinal!, 0)).getUTCDate();
  return Array.from({ length }, (_, index) => {
    const day = index + 1;
    const date = `${month}-${String(day).padStart(2, "0")}`;
    return {
      date,
      day,
      weekday: new Date(first + index * 86400000).getUTCDay(),
    };
  });
}

export function manilaInstantDate(instant: number) {
  return new Date(instant + 8 * 3600000).toISOString().slice(0, 10);
}

export function currentManilaDate() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(Date.now());
  const part = (type: string) =>
    parts.find((value) => value.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function currentManilaMonth() {
  return currentManilaDate().slice(0, 7);
}
