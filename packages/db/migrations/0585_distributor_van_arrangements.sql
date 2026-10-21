-- F-408 configurable partner operation of existing company-owned consignment vans.
-- Stock, sales, returns and settlement stay in the single VAN/INVENTORY/SAP authorities.
CREATE TABLE distributor_van_arrangements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), distributor_id uuid NOT NULL REFERENCES distributors(id),
 vehicle_id uuid NOT NULL REFERENCES vehicles(id), stock_owner text NOT NULL CHECK(stock_owner='sunpride'),
 reference text NOT NULL, source text NOT NULL CHECK(source IN ('sample','office')),
 effective_from timestamptz NOT NULL, effective_to timestamptz,
 created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(effective_to IS NULL OR effective_to>effective_from),
 EXCLUDE USING gist(vehicle_id WITH =,tstzrange(effective_from,effective_to,'[)') WITH &&)
);
ALTER TABLE van_trips ADD COLUMN distributor_id uuid REFERENCES distributors(id);
CREATE INDEX van_partner_trips ON van_trips(distributor_id,service_date) WHERE distributor_id IS NOT NULL;
