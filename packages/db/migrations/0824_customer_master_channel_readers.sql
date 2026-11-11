-- 0824_customer_master_channel_readers (SP-0170 rule 11): everything that grouped by the old
-- sample channel keys now groups by the client's Distribution Channel name.
--  * customer_master_channel_name(old key): the Distribution Channel most stores with that old
--    key moved to (ties: lowest code), else the 0823 mapping; a value that already is a
--    Distribution Channel name is kept.
--  * channel targets (sales_targets level 'channel') and people's channel scope
--    (profiles.channel_scope, territories.channel) are re-keyed with it, so the
--    company -> channel -> territory -> agent target tree and the analytics channel filter agree.
--  * the analytics master fingerprint also covers customer profiles and reference lists, so a
--    changed Distribution Channel invalidates the cached daily tiles.
-- outlets.channel keeps the legacy key: it is the price-list / call-flow eligibility key the
-- pricing engine and both phone apps already use (new customers carry their channel code).

create function customer_master_channel_name(p_key text) returns text
language sql stable as $$
  select case
    when p_key is null or btrim(p_key) = '' then p_key
    when exists (select 1 from customer_reference_values v where v.list = 'distribution_channel' and v.name = p_key) then p_key
    else coalesce(
      (select v.name from outlets o join customer_profiles p on p.outlet_id = o.id
         join customer_reference_values v on v.list = 'distribution_channel'
           and v.sales_org_code = p.sales_org_code and v.code = p.distribution_channel_code
       where o.deleted_at is null and lower(o.channel) = lower(p_key)
       group by v.name, v.code order by count(*) desc, v.code limit 1),
      (select v.name from customer_reference_values v where v.list = 'distribution_channel'
         and v.sales_org_code = '1000' and v.code = (customer_master_legacy_mapping(p_key, null)).channel_code),
      p_key)
  end
$$;

create or replace function customer_master_rekey_channel_targets() returns void
language plpgsql as $$
begin
  with mapped as (
    select t.id, t.month, t.amount_centavos, customer_master_channel_name(t.target_key) as new_key
    from sales_targets t
    where t.level = 'channel' and t.deleted_at is null
      and not exists (select 1 from customer_reference_values v where v.list = 'distribution_channel' and v.name = t.target_key)
  ), ranked as (
    select m.*, row_number() over (partition by m.month, m.new_key order by m.id) as rn,
      sum(m.amount_centavos) over (partition by m.month, m.new_key) as total
    from mapped m
  ), retired as (
    update sales_targets t set deleted_at = now() from ranked r where r.id = t.id and r.rn > 1 returning t.id
  )
  update sales_targets t set target_key = r.new_key, amount_centavos = r.total,
    value = round(r.total / 100.0, 2)
  from ranked r where r.id = t.id and r.rn = 1 and (select count(*) from retired) >= 0;
  update profiles set channel_scope = customer_master_channel_name(channel_scope)
  where channel_scope is not null and channel_scope is distinct from customer_master_channel_name(channel_scope);
  update territories set channel = customer_master_channel_name(channel)
  where channel is not null and channel is distinct from customer_master_channel_name(channel);
end $$;

select customer_master_rekey_channel_targets();

create or replace function analytics_master_fingerprint() returns text language sql stable as $$
 select concat_ws(':',
 (select concat(count(*),'-',coalesce(max(change_seq),0)) from profiles),
 (select concat(count(*),'-',coalesce(max(change_seq),0)) from employee_assignments),
 (select concat(count(*),'-',coalesce(max(change_seq),0)) from outlets),
 (select concat(count(*),'-',coalesce(max(change_seq),0)) from outlet_assignments),
 (select concat(count(*),'-',coalesce(max(change_seq),0)) from outlet_customer_links),
 (select concat(count(*),'-',coalesce(max(change_seq),0)) from territory_ownerships),
 (select concat(count(*),'-',coalesce(max(change_seq),0)) from territories),
 (select concat(count(*),'-',coalesce(max(change_seq),0)) from products),
 (select concat(count(*),'-',coalesce(max(change_seq),0)) from inventory_locations),
 (select concat(count(*),'-',coalesce(max(change_seq),0)) from customer_profiles),
 (select concat(count(*),'-',coalesce(max(change_seq),0)) from customer_reference_values))
$$;
