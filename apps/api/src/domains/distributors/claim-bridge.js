import { submitClaim as submitShared, readEvidence } from "../tpm/claims.js";
import { digest, fail } from "./model.js";

/** F-409/F-505: legacy partner rows are intake/source references; only TPM owns validation and settlement.
 * @param {any} c @param {any} d @param {any} row @param {string[]} evidenceIds */
export async function bridgeClaim(c, d, row, evidenceIds) {
  const [old] = await c.db`select id from claims where id=${row.id}`;
  if (old) return old.id;
  const code = `DISTRIBUTOR-${row.kind}`;
  await c.db`select pg_advisory_xact_lock(hashtextextended(${code},0))`;
  let [type] =
    await c.db`select * from claim_types where code=${code} and effective_from<=now() and effective_to>now()`;
  if (!type)
    [type] =
      await c.db`insert into claim_types(code,effective_from,effective_to,required_evidence,source) values(${code},${new Date(c.now)},'9999-01-01',${["source_document"]},${d.source === "sample" ? "sample" : "office"}) returning *`;
  await submitShared(
    c,
    {
      partyType: "distributor",
      partyId: d.id,
      partyName: d.name,
      typeId: type.id,
      reference: `D-${d.code}-${row.claim_number}`.slice(0, 120),
      periodFrom: row.period_from.toISOString().slice(0, 10),
      periodTo: row.period_to.toISOString().slice(0, 10),
      amountCentavos: Number(row.amount_centavos),
    },
    row.id,
  );
  for (const id of evidenceIds) {
    const source = await readEvidence(c, "source_document", id);
    if (!source || source.partyId !== d.id)
      fail("Claim evidence outside this distributor", "out_of_scope", 403);
    const [used] =
      await c.db`select id from claim_evidence where fingerprint=${source.fingerprint}`;
    if (used) fail("Evidence was already used by another claim");
    await c.db`insert into claim_evidence(claim_id,kind,source_id,fingerprint,snapshot) values(${row.id},'source_document',${id},${source.fingerprint},${source})`;
  }
  return row.id;
}
