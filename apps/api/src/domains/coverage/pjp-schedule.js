import { DAY, fail, localDate, manilaDate, monthDates } from "./model.js";

/** F-201: deterministic, capacity-aware beat-cycle generation; no writes.
 * @param {any} template @param {any[]} outlets @param {any[]} policies @param {string} month
 */
export function schedulePjp(template, outlets, policies, month) {
  const dates = monthDates(month).filter((date) => {
    const at = localDate(date);
    return (
      at >= +new Date(template.effective_from) &&
      at < +new Date(template.effective_to)
    );
  });
  if (!dates.length) fail("Template does not cover this month");
  const anchor = localDate(
    template.anchor_date instanceof Date
      ? template.anchor_date.toISOString().slice(0, 10)
      : template.anchor_date,
  );
  const days = dates.map((date) => ({
    date,
    weekday: new Date(date + "T00:00:00Z").getUTCDay(),
    visits: 0,
    serviceMinutes: 0,
    travelMinutes: 0,
    totalMinutes: 0,
    capacityMinutes: template.capacity_minutes,
  }));
  /** @type {any[]} */ const slots = [];
  /** @type {any[]} */ const roster = [];
  /** @type {any[]} */ const assignments = [];
  for (const outlet of [...outlets].sort((a, b) => a.id.localeCompare(b.id))) {
    const stop = template.stops.find(
      (/** @type {any} */ s) => s.outletId === outlet.id,
    );
    const applicable = (/** @type {string} */ date) => {
      const at = localDate(date);
      const matches = policies.filter(
        (p) =>
          p.org_unit_id === template.org_unit_id &&
          p.class_key === outlet.classification &&
          +new Date(p.effective_from) <= at &&
          (p.effective_to == null || +new Date(p.effective_to) > at),
      );
      if (matches.length !== 1)
        fail(`Set one effective visit policy for ${outlet.name} on ${date}`);
      return matches[0];
    };
    // Phase is a stable four-week beat, not the ordinal week of each month.
    const first = applicable(dates[0]);
    const phases =
      stop.phaseWeek == null
        ? Array.from({ length: first.interval_weeks }, (_, i) => i)
        : [stop.phaseWeek];
    const weekdays =
      stop.weekday == null ? template.selling_weekdays : [stop.weekday];
    const candidates = [];
    for (const weekday of weekdays)
      for (const phase of phases) {
        if (
          !template.selling_weekdays.includes(weekday) ||
          phase < 0 ||
          phase >= first.interval_weeks
        )
          fail("Beat day or phase is outside the visit policy");
        const matches = days.filter((d) => {
          const p = applicable(d.date);
          if (phase >= p.interval_weeks)
            fail(
              "Policy frequency changes require a new effective beat template",
            );
          const week = Math.floor((localDate(d.date) - anchor) / (7 * DAY));
          return (
            d.weekday === weekday &&
            ((week % p.interval_weeks) + p.interval_weeks) %
              p.interval_weeks ===
              phase
          );
        });
        // Minimize overload first, then the squared daily workload. Stable tie order.
        const score = matches.reduce((n, d) => {
          const load =
            d.totalMinutes +
            applicable(d.date).service_minutes +
            template.travel_minutes;
          return (
            n + Math.max(0, load - d.capacityMinutes) * 1000000 + load * load
          );
        }, 0);
        candidates.push({ weekday, phase, matches, score });
      }
    candidates.sort(
      (a, b) => a.score - b.score || a.weekday - b.weekday || a.phase - b.phase,
    );
    const chosen = candidates[0];
    if (!chosen) fail("At least one selling weekday is required");
    assignments.push({
      outletId: outlet.id,
      outletName: outlet.name,
      classKey: outlet.classification,
      weekday: chosen.weekday,
      phaseWeek: chosen.phase,
      potential: outlet.sales_potential,
      latitude: outlet.latitude,
      longitude: outlet.longitude,
      visits: chosen.matches.length,
    });
    const customLocalDates = [];
    for (const day of chosen.matches) {
      const policy = applicable(day.date);
      customLocalDates.push(day.date);
      day.visits++;
      day.serviceMinutes += policy.service_minutes;
      day.travelMinutes += template.travel_minutes;
      day.totalMinutes = day.serviceMinutes + day.travelMinutes;
      slots.push({
        slotKey: `pjp:${day.date}:${outlet.id}`,
        serviceDate: day.date,
        kind: "outlet_visit",
        outletId: outlet.id,
        routeId: outlet.route_id,
        sequence: 0,
        expectedDurationMinutes: policy.service_minutes,
        requiredObjectives: policy.objectives,
        intents: [],
        policyId: policy.id,
        beat: outlet.route_name,
        territoryId: outlet.territory_id,
      });
    }
    // A partial month may have no occurrence for a fortnightly/monthly stop.
    if (customLocalDates.length)
      roster.push({
        outletId: outlet.id,
        routeId: outlet.route_id,
        territoryId: outlet.territory_id,
        frequency: "custom",
        preferredWeekdays: [chosen.weekday],
        customLocalDates,
        priority: 0,
        expectedDurationMinutes: first.service_minutes,
        requiredObjectives: first.objectives,
      });
  }
  slots.sort(
    (a, b) =>
      a.serviceDate.localeCompare(b.serviceDate) ||
      String(a.routeId).localeCompare(String(b.routeId)) ||
      (outlets.find((o) => o.id === a.outletId).sequence ?? 0) -
        (outlets.find((o) => o.id === b.outletId).sequence ?? 0) ||
      a.outletId.localeCompare(b.outletId),
  );
  const seq = new Map();
  for (const slot of slots) {
    const n = (seq.get(slot.serviceDate) ?? 0) + 1;
    seq.set(slot.serviceDate, n);
    slot.sequence = n;
  }
  if (slots.length > 500)
    fail("Generated schedule exceeds 500 visits; split the template");
  return {
    month,
    fromDate: dates[0],
    toDate: manilaDate(localDate(dates[dates.length - 1]) + DAY),
    outlets: roster,
    slots,
    days,
    assignments,
    outletCount: outlets.length,
    potential: outlets.reduce((n, o) => n + Number(o.sales_potential ?? 0), 0),
    potentialIncomplete: outlets.some((o) => o.sales_potential == null),
    totalVisits: slots.length,
    serviceMinutes: days.reduce((n, d) => n + d.serviceMinutes, 0),
    travelMinutes: days.reduce((n, d) => n + d.travelMinutes, 0),
    overloadedDays: days.filter((d) => d.totalMinutes > d.capacityMinutes),
    travelSource:
      "Provisional minutes per stop from the editable template; not a road-routing estimate",
  };
}
