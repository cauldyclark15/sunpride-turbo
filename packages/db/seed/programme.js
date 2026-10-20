// v2 spec PROGRAMME: load Sunpride's Phase 1 feature list (F-001..F-616, F-R01..F-R08) and our
// status into spec_waves/spec_features. Idempotent: a repeat with the same file changes nothing.
import { tx } from "../src/client.js";
import data from "./spec-features.json" with { type: "json" };

export const SPEC_STATUSES = Object.freeze([
  "built",
  "partly_built",
  "changing_to_spec",
  "not_built",
  "needs_sunpride",
  "conditional",
]);

/** Validate the bundled file before touching the database. @param {typeof data} d */
export function validateSpecData(d) {
  const waves = new Set(d.waves.map((w) => w.code));
  if (waves.size !== d.waves.length) throw new Error("Duplicate spec wave");
  const ids = new Set();
  for (const f of d.features) {
    if (ids.has(f.id)) throw new Error(`Duplicate spec feature ${f.id}`);
    ids.add(f.id);
    if (!waves.has(f.wave)) throw new Error(`Unknown wave for ${f.id}`);
    if (!SPEC_STATUSES.includes(f.status))
      throw new Error(`Unknown status for ${f.id}`);
  }
  return { waves: waves.size, features: ids.size };
}

/**
 * Upsert every wave and feature. Returns how many rows were inserted or changed.
 * @param {import('../src/client.js').Db} db
 * @param {typeof data} [d]
 */
export async function seedProgramme(db, d = data) {
  const counts = validateSpecData(d);
  return tx(db, async (t) => {
    await t`select pg_advisory_xact_lock(hashtext('sunpride:programme-seed'))`;
    let changed = 0;
    for (const [sort, w] of d.waves.entries()) {
      const rows = await t`
        insert into spec_waves (code, name, months, go_no_go_owner, exit_criteria, sort)
        values (${w.code}, ${w.name}, ${w.months}, ${w.owner}, ${JSON.stringify(w.exit)}::text::jsonb, ${sort + 1})
        on conflict (code) do update set
          name = excluded.name, months = excluded.months,
          go_no_go_owner = excluded.go_no_go_owner, exit_criteria = excluded.exit_criteria,
          sort = excluded.sort, updated_at = now()
        where (spec_waves.name, spec_waves.months, spec_waves.go_no_go_owner, spec_waves.exit_criteria, spec_waves.sort)
          is distinct from (excluded.name, excluded.months, excluded.go_no_go_owner, excluded.exit_criteria, excluded.sort)
        returning code`;
      changed += rows.length;
    }
    for (const f of d.features) {
      const rows = await t`
        insert into spec_features (feature_id, wave_code, name, description, block_id, block_name,
          layer, module, moscow, complexity, depends_on, block_role, status, now_note, next_note,
          lane_when, deferral_pool, sort)
        values (${f.id}, ${f.wave}, ${f.name}, ${f.description}, ${f.blockId}, ${f.block},
          ${f.layer}, ${f.module}, ${f.moscow}, ${f.complexity}, ${f.dependsOn}, ${f.blockRole},
          ${f.status}, ${f.now}, ${f.next}, ${f.laneWhen}, ${f.deferralPool}, ${f.sort})
        on conflict (feature_id) do update set
          wave_code = excluded.wave_code, name = excluded.name, description = excluded.description,
          block_id = excluded.block_id, block_name = excluded.block_name, layer = excluded.layer,
          module = excluded.module, moscow = excluded.moscow, complexity = excluded.complexity,
          depends_on = excluded.depends_on, block_role = excluded.block_role, status = excluded.status,
          now_note = excluded.now_note, next_note = excluded.next_note, lane_when = excluded.lane_when,
          deferral_pool = excluded.deferral_pool, sort = excluded.sort, updated_at = now()
        where (spec_features.wave_code, spec_features.name, spec_features.description,
               spec_features.block_id, spec_features.block_name, spec_features.layer,
               spec_features.module, spec_features.moscow, spec_features.complexity,
               spec_features.depends_on, spec_features.block_role, spec_features.status,
               spec_features.now_note, spec_features.next_note, spec_features.lane_when,
               spec_features.deferral_pool, spec_features.sort)
          is distinct from (excluded.wave_code, excluded.name, excluded.description,
               excluded.block_id, excluded.block_name, excluded.layer, excluded.module,
               excluded.moscow, excluded.complexity, excluded.depends_on, excluded.block_role,
               excluded.status, excluded.now_note, excluded.next_note, excluded.lane_when,
               excluded.deferral_pool, excluded.sort)
        returning feature_id`;
      changed += rows.length;
    }
    return { ...counts, changed };
  });
}
