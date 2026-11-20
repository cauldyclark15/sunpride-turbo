-- SP-0229: additional enrollment fields, without changing the client's fixed SAP fields.
CREATE TABLE enrollment_forms (
  id text PRIMARY KEY CHECK (id = 'customer'),
  revision integer NOT NULL DEFAULT 0,
  fields jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(fields) = 'array'),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO enrollment_forms(id) VALUES ('customer');
ALTER TABLE customer_profiles ADD COLUMN custom_fields jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(custom_fields) = 'object');
