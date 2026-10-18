-- Expand/contract: old production INSERT omits coverage.
-- BEFORE INSERT fills NULL coverage from shift (AM/PM), never FULL_DAY.
-- New app always writes coverage explicitly.
-- Production migrate 실행은 이 PR에서 하지 않는다.

CREATE OR REPLACE FUNCTION marshal_penalty_fill_coverage()
RETURNS trigger AS $$
BEGIN
  IF NEW.coverage IS NULL THEN
    IF NEW.shift = 'AM' THEN
      NEW.coverage := 'AM'::"MarshalPenaltyCoverage";
    ELSE
      NEW.coverage := 'PM'::"MarshalPenaltyCoverage";
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS marshal_penalty_fill_coverage ON "MarshalPenaltyDuty";
CREATE TRIGGER marshal_penalty_fill_coverage
BEFORE INSERT ON "MarshalPenaltyDuty"
FOR EACH ROW
EXECUTE FUNCTION marshal_penalty_fill_coverage();
