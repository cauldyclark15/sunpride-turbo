# F-412 connector sample files

The CSV and nested JSON are FICTIONAL samples, not client invoices. Download them from `/samples/distributors/secondary-sales.csv` and `/samples/distributors/secondary-invoices.json`.

1. Map EXT-STORE to an assigned shared retailer, EXT-SKU to an assigned product, and WH to the partner warehouse.
2. Use the catalog selling unit, whole quantities and integer centavos. The sample catalog sells cases of 24 pieces. The date is a Manila service date; replace it with the actual export date.
3. Stage through POST /api/v1/distributors/secondary/stage with distributorId, requestKey, adapter, sourceKey and csv/rows/invoices. This uses the ordinary cookie or native access bearer; no unauthenticated ingestion endpoint or shared connector password exists.
4. Process with POST /api/v1/distributors/secondary/process and runId. Unmapped/rejected rows remain in the visible queue. Correct mapping and retry with a new command request key; source rows never change.
5. sourceKey identifies the same export on retry. An altered export under the same sourceKey conflicts. Canonical fact identity is distributor + invoiceNumber + lineKey + revision, independent of the file/API/DSR adapter.
6. Exact repeated lines are duplicates. Corrections require revision+1 and previousHash from the current line's payload_hash. Linked returns use kind=return and originalInvoiceNumber; they cannot exceed that retailer's original sale and use the frozen original pack.
7. To assert a complete secondary-feed period, include complete:true, from and to (up to 366 days), after every line validates. Zero-line complete-period declarations are supported. Open mapping/rejection rows never count toward completeness. Without complete-period coverage, DOI stays unknown and the inventory bridge stays incomplete.

# F-405 stock declaration adapter

POST /api/v1/distributors/stock accepts distributorId, requestKey, stockDate, revision, source, and lines [{productId,locationId,batch,expiry?,quantityBase}]. A declaration is a COMPLETE end-of-day snapshot: every assigned SKU at every warehouse/van, including zeros. Split batches into separate lines. quantityBase is physical pieces, not case counts. Revisions are append-only. The JSON HTTP endpoint is the stock system adapter; the portal also provides a row-based stock form.

# F-402 SAP master adapter contract

POST /api/v1/distributors/master/sync is Sunpride integration-admin only. Body: distributorId, requestKey, source:'sap'|'sample', sourceKey, version, effectiveFrom (ISO instant), payload:{products:[{productId,uom,unitsPerUom,priceCentavos,availableBase}],outlets:[{outletId,territoryId?}],terms:{paymentTerms,deliveryLeadDays},schemes:[{promotionId,distributorIds?,channelKeys?,startsOn?,endsOn?}],credit:{checkedAt,limitCentavos,exposureCentavos,ageing}}.

The assigned outlet is the canonical shared-universe UUID; a customer's accounting code is not an outlet. SAP snapshots are replicas with immutable payload hash, version, effective window and receive time. Only marked sample partners accept source=sample. The real credit decision and posting acknowledgements remain SAP-seam calls; a source=sap snapshot never simulates either.

# F-415/F-416 financial replicas

POST /api/v1/distributors/financial/sync accepts source, version, arItems:[{sourceKey,invoiceNumber,dueDate,balanceCentavos}], movements:[{sourceKey,date,productId,quantityBase,kind:'shipment'|'return'|'transfer'|'adjustment'}]. Shipments are positive; primary returns negative; transfers and adjustments signed. To certify a full primary-feed period, supply complete:true, sourceKey, from and to. Each complete-period receipt is versioned and hash checked. Missing source coverage never produces a certified balanced bridge. AR replicas are not reduced by advice or matching; only a refreshed SAP open item changes the displayed debt.
