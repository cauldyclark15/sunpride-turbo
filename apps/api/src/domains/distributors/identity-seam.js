// SEAM(ORG): replace with the org owner's partner-device-scope provisioning API.
// The dedicated leaf is only a cache/device partition. Partner role grants NO
// employee capabilities; distributor grants remain the data authorization.
/** @param {any} c @param {any} d */
export async function ensurePartnerDeviceScope(c, d) {
  if (d.device_org_unit_id) return d.device_org_unit_id;
  await c.db`insert into org_unit_types(organization_id,code,label,level,active) values('sunpride','PARTNER','Partner device scope',5,true) on conflict(organization_id,code) do nothing`;
  const [unit] =
    await c.db`insert into org_units(organization_id,code,name,type_code,parent_id,status,effective_from) values('sunpride',${`PARTNER-${d.id}`},${d.name},'PARTNER',${d.org_unit_id},'active',now()) returning id`;
  await c.db`update distributors set device_org_unit_id=${unit.id},updated_at=now() where id=${d.id}`;
  d.device_org_unit_id = unit.id;
  return unit.id;
}
