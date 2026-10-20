-- F-406: PostgreSQL expands view '*' at CREATE time; append the frozen source/pack fields.
create or replace view distributor_secondary_current as
select f.* from distributor_secondary_lines f
where not exists(select 1 from distributor_secondary_lines n where n.supersedes_id=f.id);
