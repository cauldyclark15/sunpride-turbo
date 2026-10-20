-- F-224: territory rebalancing scenarios. A draft lists outlet moves between territories; simulation stores the
-- before/after workload it was approved against. Publication writes ONLY through the ORG outlet assignment writer
-- (effective-dated, signed-plan locks); this table never owns territory membership.
CREATE TABLE territory_scenarios (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
 effective_on date NOT NULL,
 assumptions jsonb NOT NULL,
 moves jsonb NOT NULL,
 simulation jsonb NOT NULL,
 input_fingerprint text NOT NULL,
 content_hash text NOT NULL,
 status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'discarded')),
 prepared_by uuid NOT NULL REFERENCES profiles(id),
 published_by uuid REFERENCES profiles(id),
 published_at timestamptz,
 assignment_ids uuid[],
 client_key text NOT NULL, request_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (prepared_by, client_key),
 CHECK (status <> 'published' OR (published_by IS NOT NULL AND published_by <> prepared_by AND assignment_ids IS NOT NULL))
);
CREATE INDEX territory_scenarios_status ON territory_scenarios(status, created_at);
