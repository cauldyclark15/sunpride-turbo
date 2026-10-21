-- F-603/F-607: read the distributor authorities directly; never create a second sales/stock writer.
-- Distributor quantities are captured in whole base units (scale 1), not the mutable product encoding.
CREATE VIEW analytics_trade_sources AS
SELECT f.id,f.kind,f.source_system,f.source_key,f.source_revision,f.source_received_at,f.source_effective_at,
 f.source_type,f.org_unit_id,f.distributor_key,f.distributor_name,f.outlet_id,f.product_id,f.service_date,
 f.quantity_base,f.amount_centavos,f.campaign_ref,f.channel,f.account_name,f.lineage,f.created_at,f.updated_at,f.quantity_scale
FROM analytics_trade_inputs f
WHERE NOT EXISTS (
 SELECT 1 FROM distributors d WHERE f.distributor_key IN (d.id::text,d.code)
 AND ((f.kind='primary' AND EXISTS(SELECT 1 FROM distributor_primary_movements m WHERE m.distributor_id=d.id))
 OR (f.kind='secondary' AND EXISTS(SELECT 1 FROM distributor_secondary_current l WHERE l.distributor_id=d.id))
 OR (f.kind='stock' AND EXISTS(SELECT 1 FROM distributor_stock_declarations s WHERE s.distributor_id=d.id)))
)
UNION ALL
SELECT m.id,'primary','distributor_primary_movements',m.source_key,m.version::text,m.received_at,
 m.movement_date::timestamp AT TIME ZONE 'Asia/Manila',CASE WHEN m.source='sample' THEN 'sample' ELSE 'replica' END,
 d.org_unit_id,d.id::text,d.name,NULL::uuid,m.product_id,m.movement_date,
 CASE WHEN m.kind='return' THEN -abs(m.quantity_base) ELSE m.quantity_base END,NULL::bigint,NULL::text,NULL::text,d.name,
 jsonb_build_object('table','distributor_primary_movements','id',m.id,'kind',m.kind,'financialValue','not supplied'),m.created_at,m.updated_at,1::bigint
FROM distributor_primary_movements m JOIN distributors d ON d.id=m.distributor_id
WHERE m.kind IN ('shipment','return') AND d.status='accredited' AND d.effective_from<=now() AND (d.effective_to IS NULL OR d.effective_to>now())
UNION ALL
SELECT l.id,'secondary','distributor_secondary_current',l.invoice_number||':'||l.line_key,l.revision::text,l.created_at,
 l.sale_date::timestamp AT TIME ZONE 'Asia/Manila',CASE WHEN d.source='sample' THEN 'sample' ELSE 'replica' END,
 d.org_unit_id,d.id::text,d.name,l.outlet_id,l.product_id,l.sale_date,
 CASE WHEN l.kind='return' THEN -l.quantity_base ELSE l.quantity_base END,
 CASE WHEN l.kind='return' THEN -l.amount_centavos ELSE l.amount_centavos END,NULL::text,o.channel,o.name,
 jsonb_build_object('table','distributor_secondary_lines','id',l.id,'kind',l.kind,'invoice',l.invoice_number,'uom',l.uom,'unitsPerUom',l.units_per_uom,'sourceHash',l.payload_hash),l.created_at,l.updated_at,1::bigint
FROM distributor_secondary_current l JOIN distributors d ON d.id=l.distributor_id JOIN outlets o ON o.id=l.outlet_id AND o.deleted_at IS NULL
WHERE d.status='accredited' AND d.effective_from<=now() AND (d.effective_to IS NULL OR d.effective_to>now())
 AND EXISTS(SELECT 1 FROM distributor_outlets g WHERE g.distributor_id=d.id AND g.outlet_id=l.outlet_id AND g.effective_from<=now() AND (g.effective_to IS NULL OR g.effective_to>now()))
UNION ALL
SELECT l.id,'stock','distributor_stock_lines',s.id::text||':'||l.id::text,s.revision::text,s.created_at,
 s.stock_date::timestamp AT TIME ZONE 'Asia/Manila',CASE WHEN d.source='sample' THEN 'sample' ELSE 'replica' END,
 d.org_unit_id,d.id::text,d.name,NULL::uuid,l.product_id,s.stock_date,l.quantity_base,NULL::bigint,NULL::text,NULL::text,d.name,
 jsonb_build_object('table','distributor_stock_lines','id',l.id,'declarationId',s.id,'locationId',l.location_id,'batch',l.batch,'expiry',l.expiry,'uom',l.uom),l.created_at,l.updated_at,1::bigint
FROM distributor_stock_lines l JOIN distributor_stock_declarations s ON s.id=l.declaration_id JOIN distributors d ON d.id=s.distributor_id
WHERE d.status='accredited' AND d.effective_from<=now() AND (d.effective_to IS NULL OR d.effective_to>now())
 AND NOT EXISTS(SELECT 1 FROM distributor_stock_declarations later WHERE later.distributor_id=s.distributor_id AND later.stock_date=s.stock_date AND later.revision>s.revision);
