-- F-224: frozen route/boundary/routing plan on the existing independently published scenario.
ALTER TABLE territory_scenarios ADD COLUMN plan jsonb NOT NULL DEFAULT '{}'::jsonb;
