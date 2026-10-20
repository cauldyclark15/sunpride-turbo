-- F-306: PO business identity survives a new effective-dated branch adapter binding.
alter table inbound_purchase_orders add column po_identity text;
update inbound_purchase_orders p set po_identity=b.branch_key || '|' || lower(p.po_number)
from mt_account_bindings b where b.id=p.binding_id and p.status='confirmed';
create unique index mt_po_business_identity on inbound_purchase_orders(po_identity) where status='confirmed';
