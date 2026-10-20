-- F-616 catalogue edits invalidate the existing authorized phone snapshot. The
-- day-manifest also includes active revision identities for scheduled changes.
create constraint trigger product_catalogue_versions_fieldsync_changed
  after insert or update or delete on product_catalogue_versions
  deferrable initially deferred
  for each row execute function fieldsync_invalidate_manifest('global');
