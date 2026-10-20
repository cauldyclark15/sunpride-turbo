// v2 spec PROGRAMME: waves → blocks → features, in the client's order, with plain status labels.

/** Plain-words status labels, matching the client crosswalk workbook. */
export const STATUS_LABELS = Object.freeze({
  built: "Built",
  partly_built: "Partly built",
  changing_to_spec: "Being changed to match your spec",
  not_built: "Not built yet",
  needs_sunpride: "Needs Sunpride",
  conditional: "Conditional",
});

/** @typedef {keyof typeof STATUS_LABELS} SpecStatus */

/** @returns {Record<SpecStatus, number>} */
function emptyCounts() {
  return {
    built: 0,
    partly_built: 0,
    changing_to_spec: 0,
    not_built: 0,
    needs_sunpride: 0,
    conditional: 0,
  };
}

/** @param {import('@sunpride/db/client').Db} db */
export async function overview(db) {
  const waves =
    await db`select code, name, months, go_no_go_owner, exit_criteria from spec_waves order by sort, code`;
  const features =
    await db`select feature_id, wave_code, name, description, block_id, block_name, moscow, status,
      now_note, next_note, lane_when, deferral_pool
      from spec_features order by sort, feature_id`;
  const totals = emptyCounts();
  /** @type {Map<string, any>} */
  const byWave = new Map();
  for (const w of waves)
    byWave.set(w.code, {
      code: w.code,
      name: w.name,
      months: w.months,
      goNoGoOwner: w.go_no_go_owner,
      exitCriteria: w.exit_criteria,
      counts: emptyCounts(),
      featureCount: 0,
      mustCount: 0,
      blocks: /** @type {any[]} */ ([]),
    });
  for (const f of features) {
    const wave = byWave.get(f.wave_code);
    if (!wave) continue;
    const status = /** @type {SpecStatus} */ (f.status);
    totals[status] += 1;
    wave.counts[status] += 1;
    wave.featureCount += 1;
    if (String(f.moscow).startsWith("Must")) wave.mustCount += 1;
    let block = wave.blocks.find((/** @type {any} */ b) => b.id === f.block_id);
    if (!block) {
      block = { id: f.block_id, name: f.block_name, features: [] };
      wave.blocks.push(block);
    }
    block.features.push({
      id: f.feature_id,
      name: f.name,
      description: f.description,
      priority: f.moscow,
      status,
      statusLabel: STATUS_LABELS[status],
      now: f.now_note,
      next: f.next_note,
      laneWhen: f.lane_when,
      deferralPool: f.deferral_pool,
    });
  }
  return {
    loaded: features.length > 0,
    featureCount: features.length,
    totals,
    statusLabels: STATUS_LABELS,
    waves: [...byWave.values()],
  };
}
