-- F-208: immutable versioned productive-call definitions and per-visit snapshots.
CREATE TABLE productive_call_policies (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id text NOT NULL DEFAULT 'sunpride',
 definition_key uuid NOT NULL DEFAULT gen_random_uuid(),
 version integer NOT NULL CHECK(version > 0),
 org_unit_id uuid NOT NULL REFERENCES org_units(id),
 position_id uuid REFERENCES positions(id),
 channel_key text,
 label text NOT NULL,
 definition jsonb NOT NULL,
 content_hash text NOT NULL,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published')),
 effective_from timestamptz NOT NULL,
 effective_to timestamptz,
 replaces_policy_id uuid REFERENCES productive_call_policies(id),
 source_ref text NOT NULL,
 prepared_by uuid NOT NULL REFERENCES profiles(id),
 approved_by uuid REFERENCES profiles(id),
 approved_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(definition_key,version),
 CHECK(effective_to IS NULL OR effective_to > effective_from),
 CHECK(status='draft' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND approved_by<>prepared_by))
);
CREATE INDEX productive_call_policies_applicability ON productive_call_policies(org_unit_id,status,effective_from,effective_to);
CREATE TABLE productive_policy_commands (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 actor_id uuid NOT NULL REFERENCES profiles(id),
 request_key text NOT NULL,
 request_hash text NOT NULL,
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(actor_id,request_key)
);
CREATE TABLE productive_policy_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 policy_id uuid NOT NULL REFERENCES productive_call_policies(id),
 actor_id uuid NOT NULL REFERENCES profiles(id),
 kind text NOT NULL,
 detail jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE visit_executions ADD COLUMN productive_policy_snapshot jsonb;
