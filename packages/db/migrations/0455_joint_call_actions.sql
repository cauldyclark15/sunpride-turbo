-- F-223: agreed actions from a Work-With (joint call), carried into the next joint call between the same
-- trainer and trainee, where each is reviewed as done or not done with a note. Reuses work_with_sessions.
CREATE TABLE joint_call_actions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 session_id uuid NOT NULL REFERENCES work_with_sessions(id),
 trainer_profile_id uuid NOT NULL REFERENCES profiles(id),
 trainee_profile_id uuid NOT NULL REFERENCES profiles(id),
 org_unit_id uuid NOT NULL REFERENCES org_units(id),
 ordinal integer NOT NULL CHECK (ordinal >= 0 AND ordinal < 10),
 agreement text NOT NULL CHECK (length(agreement) BETWEEN 1 AND 500),
 owner text NOT NULL CHECK (owner IN ('trainee', 'trainer')),
 due_on date NOT NULL,
 status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'not_done')),
 reviewed_in_session_id uuid REFERENCES work_with_sessions(id),
 review_note text,
 reviewed_by uuid REFERENCES profiles(id),
 reviewed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (session_id, ordinal),
 CHECK (status = 'open' OR (reviewed_in_session_id IS NOT NULL AND reviewed_in_session_id <> session_id AND review_note IS NOT NULL AND reviewed_by IS NOT NULL))
);
CREATE INDEX joint_call_actions_pair_open ON joint_call_actions(trainer_profile_id, trainee_profile_id, status, due_on);
CREATE INDEX joint_call_actions_reviewed_in ON joint_call_actions(reviewed_in_session_id);
