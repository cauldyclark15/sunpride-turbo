-- F-020/F-111/F-124: sale/discount header and line changes plus settlement hand-in.
create trigger fiscal_capture after insert or update or delete on van_sales for each row execute function fiscal_capture_change();
create trigger fiscal_capture after insert or update or delete on van_sale_lines for each row execute function fiscal_capture_change();
create trigger fiscal_capture after insert or update or delete on van_cash_remittances for each row execute function fiscal_capture_change();
