-- F-020: stable, bounded audit chronology, including tied transaction timestamps.
create index fiscal_audit_timeline on fiscal_audit_events(created_at desc,id desc);
