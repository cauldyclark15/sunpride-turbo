-- F-309/F-509: MT retains remittance/dispute capture; the shared deduction is its only financial control case.
ALTER TABLE mt_deductions ADD COLUMN financial_case_id uuid REFERENCES deductions(id);
INSERT INTO deductions(id,source_key,account_key,classification,invoice_reference,remittance_reference,
 amount_centavos,owner_profile_id,opened_on,due_on,created_by,status)
SELECT d.id,'mt:'||d.id::text,c.code,t.label,coalesce(i.invoice_number,'Invoice not supplied'),m.reference,
 d.amount_centavos,d.owner_profile_id,m.received_on,d.due_on,m.created_by::text,
 CASE WHEN d.status='disputed' THEN 'disputed' ELSE 'open' END
FROM mt_deductions d JOIN mt_remittances m ON m.id=d.remittance_id JOIN mt_deduction_types t ON t.id=d.type_id
JOIN mt_account_bindings b ON b.id=d.binding_id JOIN customers c ON c.id=b.customer_id
LEFT JOIN mt_invoice_replicas i ON i.id=d.invoice_id;
UPDATE mt_deductions SET financial_case_id=id;
CREATE FUNCTION mt_shared_deduction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE account text; category text; invoice text; remit text; opened date; author text;
BEGIN
 SELECT c.code,t.label,coalesce(i.invoice_number,'Invoice not supplied'),m.reference,m.received_on,m.created_by::text
 INTO account,category,invoice,remit,opened,author
 FROM mt_remittances m JOIN mt_account_bindings b ON b.id=NEW.binding_id JOIN customers c ON c.id=b.customer_id
 JOIN mt_deduction_types t ON t.id=NEW.type_id LEFT JOIN mt_invoice_replicas i ON i.id=NEW.invoice_id WHERE m.id=NEW.remittance_id;
 INSERT INTO deductions(id,source_key,account_key,classification,invoice_reference,remittance_reference,
 amount_centavos,owner_profile_id,opened_on,due_on,created_by,status)
 VALUES(NEW.id,'mt:'||NEW.id::text,account,category,invoice,remit,NEW.amount_centavos,NEW.owner_profile_id,opened,NEW.due_on,author,
 CASE WHEN NEW.status='disputed' THEN 'disputed' ELSE 'open' END)
 ON CONFLICT(id) DO UPDATE SET classification=excluded.classification,owner_profile_id=excluded.owner_profile_id,due_on=excluded.due_on,
 status=CASE WHEN deductions.status='resolved' THEN 'resolved' WHEN NEW.status='disputed' THEN 'disputed' ELSE deductions.status END,updated_at=now()
 WHERE deductions.source_key='mt:'||NEW.id::text;
 IF NOT FOUND THEN RAISE EXCEPTION 'Deduction financial identity conflicts'; END IF;
 NEW.financial_case_id=NEW.id;
 RETURN NEW;
END $$;
CREATE TRIGGER mt_financial_case BEFORE INSERT OR UPDATE ON mt_deductions FOR EACH ROW EXECUTE FUNCTION mt_shared_deduction();
