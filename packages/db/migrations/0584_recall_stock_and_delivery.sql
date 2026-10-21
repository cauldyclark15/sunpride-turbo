-- F-614: preserve new delivery units at handoff, derive trace receipts from immutable proof,
-- and let the central inventory writer enforce recall holds independently of editable QC status.
ALTER TABLE delivery_drop_lines ADD COLUMN quantity_scale integer CHECK(quantity_scale>0);
ALTER TABLE retail_batch_receipts ADD COLUMN quantity_scale integer CHECK(quantity_scale>0);
ALTER TABLE retail_batch_receipts ADD COLUMN source_uom text;
ALTER TABLE retail_batch_receipts ADD COLUMN source_org_unit_id uuid REFERENCES org_units(id);
CREATE TABLE inventory_lot_holds (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), lot_id uuid NOT NULL REFERENCES inventory_lots(id),
 source_type text NOT NULL, source_id uuid NOT NULL, actor_subject text NOT NULL,
 released_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(lot_id,source_type,source_id)
);
CREATE INDEX inventory_active_lot_holds ON inventory_lot_holds(lot_id) WHERE released_at IS NULL;
CREATE FUNCTION retail_receipts_for_proof(p delivery_proofs) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO retail_batch_receipts(outlet_id,lot_id,quantity_base,source_key,source_kind,source_version,received_at,actor_subject,quantity_scale,source_uom,source_org_unit_id)
 SELECT h.outlet_id,l.id,(x->>'acceptedBase')::bigint,'delivery-proof:'||p.id::text||':'||dl.id::text,
 'delivery_confirmation',p.payload_hash,p.captured_at,pr.auth_subject,dl.quantity_scale,dl.uom,h.org_unit_id
 FROM jsonb_array_elements(p.lines) x JOIN delivery_drop_lines dl ON dl.id=(x->>'lineId')::uuid AND dl.drop_id=p.drop_id
 JOIN delivery_drops d ON d.id=dl.drop_id JOIN delivery_handoffs h ON h.id=d.handoff_id JOIN profiles pr ON pr.id=p.profile_id
 JOIN inventory_lots l ON l.organization_id='sunpride' AND l.product_id=dl.product_id AND l.normalized_lot_number=upper(trim(x->>'lotNumber'))
 WHERE (x->>'acceptedBase')::bigint>0 AND nullif(trim(x->>'lotNumber'),'') IS NOT NULL
 ON CONFLICT(source_key) DO NOTHING;
END $$;
SELECT retail_receipts_for_proof(p) FROM delivery_proofs p;
CREATE FUNCTION retail_delivery_proof_receipts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM retail_receipts_for_proof(NEW); RETURN NEW; END $$;
CREATE TRIGGER retail_delivery_receipts AFTER INSERT ON delivery_proofs FOR EACH ROW EXECUTE FUNCTION retail_delivery_proof_receipts();
