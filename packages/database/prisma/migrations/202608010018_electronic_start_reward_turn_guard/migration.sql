CREATE FUNCTION reject_duplicate_start_reward_for_turn()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."turnId" IS NULL
     OR NEW."type" <> 'START_REWARD'
     OR NEW."status" NOT IN ('PENDING', 'APPROVED', 'EXECUTED', 'REVERSED') THEN
    RETURN NEW;
  END IF;

  -- Preserve legacy terminal rows while still guarding any newly active row.
  IF TG_OP = 'UPDATE'
     AND OLD."turnId" IS NOT DISTINCT FROM NEW."turnId"
     AND OLD."type" IS NOT DISTINCT FROM NEW."type"
     AND OLD."status" IN ('PENDING', 'APPROVED', 'EXECUTED', 'REVERSED') THEN
    RETURN NEW;
  END IF;

  -- Serialize checks for the same turn so concurrent inserts cannot both pass.
  PERFORM 1 FROM "Turn" WHERE "id" = NEW."turnId" FOR UPDATE;
  IF EXISTS (
    SELECT 1
    FROM "GameRequest" AS existing
    WHERE existing."turnId" = NEW."turnId"
      AND existing."type" = 'START_REWARD'
      AND existing."status" IN ('PENDING', 'APPROVED', 'EXECUTED', 'REVERSED')
      AND existing."id" <> NEW."id"
  ) THEN
    RAISE EXCEPTION 'one electronic START_REWARD per turn';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "GameRequest_one_start_reward_per_turn"
BEFORE INSERT OR UPDATE OF "turnId", "type", "status" ON "GameRequest"
FOR EACH ROW EXECUTE FUNCTION reject_duplicate_start_reward_for_turn();
