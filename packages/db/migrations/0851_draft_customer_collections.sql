-- SP-0241: preserve a genuine full collection against a new customer before office completion.
-- No invented accounting customer or AR posting. Approval can reconcile the known outlet later.
alter table field_collections alter column customer_id drop not null;
alter table field_collections add constraint field_collection_customer_or_review
  check (customer_id is not null or status in ('pending_review','rejected'));
