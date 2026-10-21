-- F-613: provenance on the existing promise; bounded field evidence links to canonical Money records.
ALTER TABLE collection_promises ADD COLUMN ar_source jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE TABLE collection_capture_evidence (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_unit_id uuid NOT NULL REFERENCES org_units(id),
 collector_profile_id uuid NOT NULL REFERENCES profiles(id),
 customer_code text NOT NULL,
 route_date date NOT NULL,
 promise_id uuid REFERENCES collection_promises(id),
 cheque_id uuid REFERENCES cheque_instruments(id),
 client_request_id uuid NOT NULL UNIQUE,
 captured_at timestamptz NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now(),
 note text NOT NULL CHECK(length(note) BETWEEN 1 AND 500),
 photo jsonb,
 CHECK(num_nonnulls(promise_id,cheque_id)=1),
 CHECK(photo IS NULL OR (jsonb_typeof(photo)='object' AND pg_column_size(photo)<=100000))
);
CREATE INDEX collection_capture_evidence_cheque ON collection_capture_evidence(cheque_id,received_at);
CREATE INDEX collection_capture_evidence_promise ON collection_capture_evidence(promise_id,received_at);
