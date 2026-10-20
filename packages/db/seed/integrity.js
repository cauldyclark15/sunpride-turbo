/** Clearly invented fleet facts only; never pretends a physical phone enrolled or passed MDM.
 * @param {import('./store.js').Dataset} d @param {import('./company.js').Company} c
 */
export function integrityFleet(d, c) {
  for (const [i, person] of c.agents.entries())
    d.add("fleet_asset_versions", `phone-${person.id}`, {
      asset_tag: `SAMPLE-PHONE-${person.employee_code ?? String(i + 1).padStart(2, "0")}`,
      org_unit_id: person.org_unit_id,
      assigned_profile_id: person.id,
      model: "SAMPLE entry-level Android phone",
      state: "assigned",
      peripherals:
        i % 3 === 0
          ? [
              { kind: "printer", tag: `SAMPLE-PRINTER-${i + 1}` },
              { kind: "scanner", tag: `SAMPLE-SCANNER-${i + 1}` },
            ]
          : [],
      mdm_status: "unknown",
      mdm_source: "SAMPLE invented fleet register; no MDM observation",
      data_plan: "SAMPLE 5 GB/month",
      note: "SAMPLE assignment; not proof of device enrollment or MDM compliance",
      effective_from: d.epoch,
      source_ref: "SAMPLE provisional F-021 fleet register",
    });
  for (const [i, state] of ["spare", "spare", "repair"].entries())
    d.add("fleet_asset_versions", `reserve-${i}`, {
      asset_tag: `SAMPLE-RESERVE-${i + 1}`,
      org_unit_id: c.root.id,
      model: "SAMPLE reserve Android phone",
      state,
      peripherals: [],
      mdm_status: "unknown",
      mdm_source: "SAMPLE no MDM observation",
      data_plan: "SAMPLE unassigned plan",
      break_fix_due_at:
        state === "repair"
          ? new Date(Date.parse(d.noon) + 86_400_000).toISOString()
          : null,
      note:
        state === "repair"
          ? "SAMPLE cracked screen; replace before assignment"
          : "SAMPLE available spare",
      effective_from: d.epoch,
      source_ref: "SAMPLE provisional F-021 fleet register",
    });
}
