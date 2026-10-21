-- F-501/F-504: retain commitments and append reversals; never erase earned-spend history.
CREATE TABLE campaign_commitment_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  commitment_id uuid NOT NULL REFERENCES campaign_commitments(id),
  source_key text NOT NULL UNIQUE,
  amount_centavos bigint NOT NULL CHECK (amount_centavos > 0),
  reason text NOT NULL,
  actor_subject text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION guard_campaign_release() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE committed bigint; released bigint;
BEGIN
  SELECT amount_centavos INTO committed FROM campaign_commitments WHERE id=NEW.commitment_id FOR UPDATE;
  SELECT coalesce(sum(amount_centavos),0) INTO released FROM campaign_commitment_releases WHERE commitment_id=NEW.commitment_id;
  IF released+NEW.amount_centavos>committed THEN RAISE EXCEPTION 'Release exceeds campaign commitment'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER campaign_release_bound BEFORE INSERT ON campaign_commitment_releases FOR EACH ROW EXECUTE FUNCTION guard_campaign_release();
CREATE TRIGGER campaign_releases_immutable BEFORE UPDATE OR DELETE ON campaign_commitment_releases FOR EACH ROW EXECUTE FUNCTION tpm_immutable();
CREATE VIEW campaign_commitment_balances AS
SELECT c.id,c.campaign_id,c.campaign_version_id,c.source_key,c.created_by,c.created_at,c.updated_at,
  c.amount_centavos-coalesce((SELECT sum(r.amount_centavos) FROM campaign_commitment_releases r WHERE r.commitment_id=c.id),0) AS amount_centavos
FROM campaign_commitments c;
