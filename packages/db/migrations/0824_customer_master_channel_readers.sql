-- 0824_customer_master_channel_readers (SP-0170 rule 11): everything that grouped by the old
-- sample channel keys now groups by the client's Distribution Channel name.
--  * channel targets, people's channel scope and territory channel are re-keyed by
--    customer_master_rekey_channel_targets() (0823; runs with every sample backfill, so seeds and
--    the daily demo advance stay consistent), so the company -> channel -> territory -> agent
--    target tree and the analytics channel filter agree.
--  * the analytics master fingerprint also covers customer profiles and reference lists, so a
--    changed Distribution Channel invalidates the cached daily tiles.
-- outlets.channel keeps the legacy key: it is the price-list / call-flow eligibility key the
-- pricing engine and both phone apps already use (new customers carry their channel code).

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
