-- SP-0251: follow-up evidence never rewrites an immutable store capture.
CREATE TABLE store_location_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  capture_id uuid,
  outlet_id uuid REFERENCES outlets(id),
  actor_profile_id uuid NOT NULL REFERENCES profiles(id),
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  accuracy_meters double precision NOT NULL CHECK (accuracy_meters > 0 AND accuracy_meters <= 500),
  recorded_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (capture_id IS NOT NULL OR outlet_id IS NOT NULL)
);
CREATE INDEX store_location_tags_capture ON store_location_tags(capture_id, accuracy_meters, recorded_at DESC);
CREATE INDEX store_location_tags_outlet ON store_location_tags(outlet_id, accuracy_meters, recorded_at DESC);
