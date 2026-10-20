-- F-209/F-222: configured offline field forms; extend the existing prospect universe.
CREATE TABLE workforce_form_policies (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_unit_id uuid NOT NULL REFERENCES org_units(id),
 version integer NOT NULL CHECK(version>0),
 label text NOT NULL, source_ref text NOT NULL,
 configuration jsonb NOT NULL, content_hash text NOT NULL,
 effective_from timestamptz NOT NULL, effective_to timestamptz,
 created_by uuid NOT NULL REFERENCES profiles(id),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(org_unit_id,version), UNIQUE(org_unit_id,effective_from),
 CHECK(effective_to IS NULL OR effective_to>effective_from)
);
ALTER TABLE workforce_form_policies ADD CONSTRAINT workforce_form_policy_no_overlap
 EXCLUDE USING gist (org_unit_id WITH =,tstzrange(effective_from,effective_to,'[)') WITH &&);
ALTER TABLE outlet_enrolments ADD COLUMN capture_snapshot jsonb;
ALTER TABLE outlet_enrolments ADD COLUMN capture_review jsonb;
ALTER TABLE outlet_enrolments ADD COLUMN resolved_outlet_id uuid REFERENCES outlets(id);
CREATE TABLE attendance_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 profile_id uuid NOT NULL REFERENCES profiles(id), org_unit_id uuid NOT NULL REFERENCES org_units(id),
 service_date date NOT NULL, clock_in_request_id uuid NOT NULL UNIQUE,
 clock_in_at timestamptz NOT NULL, clock_in_device_id uuid NOT NULL REFERENCES registered_devices(id),
 clock_in_snapshot jsonb NOT NULL, photo_file_id uuid NOT NULL REFERENCES files(id),
 clock_out_request_id uuid UNIQUE, clock_out_at timestamptz,
 clock_out_device_id uuid REFERENCES registered_devices(id),
 clock_out_snapshot jsonb, review_flags jsonb NOT NULL DEFAULT '[]',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(profile_id,service_date), CHECK(clock_out_at IS NULL OR clock_out_at>=clock_in_at)
);
CREATE TABLE attendance_adjustments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 profile_id uuid NOT NULL REFERENCES profiles(id), org_unit_id uuid NOT NULL REFERENCES org_units(id),
 service_date date NOT NULL, kind text NOT NULL CHECK(kind IN ('correction','absence','leave')),
 proposed_start timestamptz, proposed_end timestamptz, reason text NOT NULL, source_ref text NOT NULL,
 client_key text NOT NULL, request_hash text NOT NULL, external_identity text UNIQUE, replaces_id uuid REFERENCES attendance_adjustments(id),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
 prepared_by uuid NOT NULL REFERENCES profiles(id), approved_by uuid REFERENCES profiles(id),
 approved_at timestamptz, decision_reason text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(prepared_by,client_key),
 CHECK(proposed_end IS NULL OR (proposed_start IS NOT NULL AND proposed_end>proposed_start)),
 CHECK(status<>'approved' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND approved_by<>prepared_by AND approved_by<>profile_id))
);
CREATE INDEX attendance_adjustments_day ON attendance_adjustments(profile_id,service_date,status);
CREATE TABLE workforce_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 profile_id uuid NOT NULL REFERENCES profiles(id), org_unit_id uuid NOT NULL REFERENCES org_units(id),
 actor_id uuid NOT NULL REFERENCES profiles(id), device_id uuid REFERENCES registered_devices(id),
 kind text NOT NULL, entity_id uuid NOT NULL, detail jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
