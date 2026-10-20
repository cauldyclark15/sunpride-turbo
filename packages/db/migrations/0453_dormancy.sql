-- F-210: cycle-based dormancy. Effective-dated thresholds, persisted detection/recovery and owner actions.
CREATE TABLE dormancy_policies (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_unit_id uuid NOT NULL REFERENCES org_units(id),
 version integer NOT NULL CHECK (version > 0),
 label text NOT NULL, source_ref text NOT NULL,
 missed_cycles integer NOT NULL CHECK (missed_cycles BETWEEN 1 AND 12),
 fallback_cycle_days integer NOT NULL CHECK (fallback_cycle_days BETWEEN 7 AND 120),
 content_hash text NOT NULL,
 effective_from timestamptz NOT NULL, effective_to timestamptz,
 created_by uuid NOT NULL REFERENCES profiles(id),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (org_unit_id, version),
 CHECK (effective_to IS NULL OR effective_to > effective_from)
);
ALTER TABLE dormancy_policies ADD CONSTRAINT dormancy_policy_no_overlap
 EXCLUDE USING gist (org_unit_id WITH =, tstzrange(effective_from, effective_to, '[)') WITH &&);
CREATE TABLE outlet_dormancy_cases (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 outlet_id uuid NOT NULL REFERENCES outlets(id),
 org_unit_id uuid NOT NULL REFERENCES org_units(id),
 policy_id uuid NOT NULL REFERENCES dormancy_policies(id),
 policy_version integer NOT NULL, policy_hash text NOT NULL,
 cycle_days integer NOT NULL CHECK (cycle_days > 0), cycle_source text NOT NULL,
 threshold_cycles integer NOT NULL, missed_cycles integer NOT NULL,
 last_purchase_on date NOT NULL, detected_on date NOT NULL,
 status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'recovered', 'closed')),
 recovered_on date, recovery_purchase_on date,
 closed_reason text, closed_by uuid REFERENCES profiles(id), closed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK (status <> 'recovered' OR (recovered_on IS NOT NULL AND recovery_purchase_on > last_purchase_on)),
 CHECK (status <> 'closed' OR (closed_reason IS NOT NULL AND closed_by IS NOT NULL))
);
CREATE UNIQUE INDEX outlet_dormancy_one_open ON outlet_dormancy_cases(outlet_id) WHERE status = 'open';
CREATE INDEX outlet_dormancy_unit ON outlet_dormancy_cases(org_unit_id, status, detected_on);
CREATE TABLE outlet_dormancy_actions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 case_id uuid NOT NULL REFERENCES outlet_dormancy_cases(id),
 kind text NOT NULL CHECK (kind IN ('recovery_visit', 'win_back_offer', 'owner_review', 'close')),
 note text NOT NULL, due_on date,
 actor_id uuid NOT NULL REFERENCES profiles(id),
 client_key text NOT NULL, request_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (actor_id, client_key)
);
CREATE INDEX outlet_dormancy_actions_case ON outlet_dormancy_actions(case_id, created_at);
