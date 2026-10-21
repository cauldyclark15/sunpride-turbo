-- F-124: the short handheld code indexes the one append-only fiscal authority; it is not another financial permission.
alter table van_approval_codes add column fiscal_request_id uuid references fiscal_override_requests(id);
alter table van_sale_voids add column note text;
