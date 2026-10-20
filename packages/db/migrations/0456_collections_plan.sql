-- F-613: collections plan on AR open items. SEAM(SAP): open items are read from the labelled sample office
-- AR snapshot until the SAP replica exists; these tables plan and track collection work, never AR balances.
CREATE TABLE collection_promises (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_unit_id uuid NOT NULL REFERENCES org_units(id),
 customer_code text NOT NULL,
 open_item_ref text,
 ar_snapshot_id uuid REFERENCES admin_pack_records(id),
 amount_minor bigint NOT NULL CHECK (amount_minor > 0),
 promised_on date NOT NULL,
 status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'kept', 'broken', 'cancelled')),
 note text NOT NULL,
 outcome_note text, outcome_by uuid REFERENCES profiles(id), outcome_at timestamptz,
 created_by uuid NOT NULL REFERENCES profiles(id),
 client_key text NOT NULL, request_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (created_by, client_key),
 CHECK (status = 'open' OR (outcome_note IS NOT NULL AND outcome_by IS NOT NULL))
);
CREATE INDEX collection_promises_unit ON collection_promises(org_unit_id, status, promised_on);
CREATE INDEX collection_promises_customer ON collection_promises(customer_code, status);
CREATE TABLE cheque_instruments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_unit_id uuid NOT NULL REFERENCES org_units(id),
 customer_code text NOT NULL,
 cheque_number text NOT NULL,
 bank text NOT NULL,
 amount_minor bigint NOT NULL CHECK (amount_minor > 0),
 cheque_date date NOT NULL,
 received_on date NOT NULL,
 promise_id uuid REFERENCES collection_promises(id),
 status text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'deposited', 'cleared', 'bounced', 'replaced')),
 replaces_id uuid REFERENCES cheque_instruments(id),
 created_by uuid NOT NULL REFERENCES profiles(id),
 client_key text NOT NULL, request_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (created_by, client_key),
 UNIQUE (bank, cheque_number),
 CHECK (replaces_id IS NULL OR replaces_id <> id)
);
CREATE INDEX cheque_instruments_unit ON cheque_instruments(org_unit_id, status, cheque_date);
CREATE UNIQUE INDEX cheque_instruments_one_replacement ON cheque_instruments(replaces_id) WHERE replaces_id IS NOT NULL;
CREATE TABLE cheque_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 cheque_id uuid NOT NULL REFERENCES cheque_instruments(id),
 kind text NOT NULL CHECK (kind IN ('received', 'deposited', 'cleared', 'bounced', 'replaced')),
 on_date date NOT NULL,
 note text,
 actor_id uuid NOT NULL REFERENCES profiles(id),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cheque_events_cheque ON cheque_events(cheque_id, created_at);
CREATE TABLE collection_route_stops (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_unit_id uuid NOT NULL REFERENCES org_units(id),
 route_date date NOT NULL,
 collector_profile_id uuid NOT NULL REFERENCES profiles(id),
 sequence integer NOT NULL CHECK (sequence > 0 AND sequence <= 60),
 customer_code text NOT NULL,
 reason text NOT NULL CHECK (reason IN ('promise_due', 'promise_overdue', 'cheque_pickup', 'cheque_replacement', 'overdue_balance', 'manual')),
 planned_by uuid NOT NULL REFERENCES profiles(id),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (route_date, collector_profile_id, sequence),
 UNIQUE (route_date, collector_profile_id, customer_code)
);
