-- F-306: retain the last validated price/gross shown before an operator confirms a PO.
-- Existing rows stay unknown until explicitly revalidated; canonical orders remain untouched.
alter table mt_po_lines add column approved_price_centavos bigint check(approved_price_centavos>=0);
alter table mt_po_lines add column gross_centavos bigint check(gross_centavos>=0);
