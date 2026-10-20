-- F-615: versioned multi-metric target cascade. A cascade allocates one parent's monthly target to its
-- complete set of children; it reconciles exactly before submission and needs an independent approver.
-- Publication of sales_value writes the existing sales_targets rows, so every screen reads one book.
CREATE TABLE target_cascades (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 month text NOT NULL CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
 metric text NOT NULL CHECK (metric IN ('sales_value', 'volume', 'coverage_stores', 'distribution_points', 'calls', 'msl_compliance')),
 product_code text,
 unit text NOT NULL,
 parent_level text NOT NULL CHECK (parent_level IN ('company', 'channel', 'territory')),
 parent_key text NOT NULL,
 parent_label text NOT NULL,
 child_level text NOT NULL CHECK (child_level IN ('channel', 'territory', 'agent')),
 parent_amount bigint NOT NULL CHECK (parent_amount >= 0),
 method text NOT NULL CHECK (method IN ('prior_actual', 'equal', 'same_rate', 'manual')),
 basis_from date, basis_to date,
 version integer NOT NULL CHECK (version > 0),
 status text NOT NULL CHECK (status IN ('submitted', 'published', 'rejected', 'superseded')),
 source_ref text NOT NULL,
 content_hash text NOT NULL,
 prepared_by uuid NOT NULL REFERENCES profiles(id),
 client_key text NOT NULL, request_hash text NOT NULL,
 decided_by uuid REFERENCES profiles(id), decided_at timestamptz, decision_reason text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((metric = 'volume') = (product_code IS NOT NULL)),
 CHECK (metric <> 'msl_compliance' OR parent_amount <= 10000),
 -- Superseded versions keep their original decider (if any); the superseding actor is in the event.
 CONSTRAINT target_cascades_decided_ck CHECK (status IN ('submitted', 'superseded') OR decided_by IS NOT NULL),
 CHECK (decided_by IS NULL OR decided_by <> prepared_by),
 UNIQUE (prepared_by, client_key)
);
CREATE UNIQUE INDEX target_cascades_version ON target_cascades(month, metric, coalesce(product_code, ''), parent_level, parent_key, version);
CREATE UNIQUE INDEX target_cascades_one_published ON target_cascades(month, metric, coalesce(product_code, ''), parent_level, parent_key) WHERE status = 'published';
CREATE INDEX target_cascades_month ON target_cascades(month, status);
CREATE TABLE target_cascade_lines (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 cascade_id uuid NOT NULL REFERENCES target_cascades(id),
 child_key text NOT NULL, child_label text NOT NULL,
 basis bigint, amount bigint NOT NULL CHECK (amount >= 0),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (cascade_id, child_key)
);
CREATE TABLE target_cascade_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 cascade_id uuid NOT NULL REFERENCES target_cascades(id),
 kind text NOT NULL CHECK (kind IN ('submitted', 'published', 'rejected', 'superseded')),
 actor_id uuid NOT NULL REFERENCES profiles(id),
 detail jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX target_cascade_events_cascade ON target_cascade_events(cascade_id, created_at);
