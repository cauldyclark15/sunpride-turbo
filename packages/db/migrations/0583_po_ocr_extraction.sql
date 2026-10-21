-- F-306 preserve assistive OCR output alongside the immutable original document.
ALTER TABLE mt_po_documents ADD COLUMN extraction jsonb NOT NULL DEFAULT '{}'::jsonb;
