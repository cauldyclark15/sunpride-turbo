-- SP-0224: dated outputs of an approved MCP, separate from legacy weekday routes.
-- Existing routes, signed plans and visit identities remain untouched.
CREATE SEQUENCE coverage_daily_route_number;
CREATE TABLE coverage_daily_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES coverage_plans(id),
  assignee_profile_id uuid NOT NULL REFERENCES profiles(id),
  service_date date NOT NULL,
  route_number bigint NOT NULL DEFAULT nextval('coverage_daily_route_number'),
  code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(plan_id, service_date),
  UNIQUE(route_number)
);
CREATE INDEX coverage_daily_routes_person_date ON coverage_daily_routes(assignee_profile_id, service_date);
CREATE TABLE coverage_week_reviews (
  plan_id uuid NOT NULL REFERENCES coverage_plans(id),
  week_start date NOT NULL,
  content_hash text NOT NULL,
  reviewed_by text NOT NULL,
  reviewed_at timestamptz NOT NULL,
  PRIMARY KEY(plan_id, week_start)
);
