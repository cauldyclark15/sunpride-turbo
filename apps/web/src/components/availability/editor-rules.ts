/** F-216: parse additional dated cumulative store milestones without changing their order. */
export function launchBuildTargets(
  date: string,
  outlets: number,
  additional: string,
) {
  const targets = [{ date, outlets }];
  for (const row of additional.split(/\r?\n/).filter((line) => line.trim())) {
    const parts = row.split(",").map((part) => part.trim());
    const [day = "", rawCount = ""] = parts;
    if (
      parts.length !== 2 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
      !/^\d+$/.test(rawCount)
    )
      throw new Error(
        "Use one date and cumulative store count per line, for example 2026-11-15, 30.",
      );
    const count = Number(rawCount);
    if (!Number.isSafeInteger(count))
      throw new Error("Use a whole, non-negative store count.");
    targets.push({ date: day, outlets: count });
  }
  return targets;
}
