-- IP-INT2FIX 0773: a default `stock` authority band for manager and admin on every branch, so a till count can be approved
-- without office set-up. Labelled 'default'; the office replaces it with its own band (the old one simply ends).
-- Manager may approve up to PHP 20,000 on their own, admin up to PHP 100,000. Safe to run again.
alter table fiscal_authority_rules add column if not exists label text;
insert into fiscal_authority_rules (org_unit_id, kind, role, channel, min_centavos, max_centavos, self_limit_centavos, approver_roles, offline_allowed, effective_from, sample, label)
select u.id, 'stock', r.role, '*', 0, 999999999999, r.self_limit, r.approvers::jsonb, false, now(), false, 'default'
  from org_units u
 cross join (values ('manager', 2000000::bigint, '["admin","super_admin"]'),
                    ('admin', 10000000::bigint, '["super_admin"]')) as r(role, self_limit, approvers)
 where u.status = 'active'
   and exists (select 1 from inventory_locations l where l.org_unit_id = u.id)
   and not exists (
     select 1 from fiscal_authority_rules f
      where f.org_unit_id = u.id and f.kind = 'stock' and f.role = r.role
        and f.effective_from <= now() and (f.effective_to is null or f.effective_to > now()));
