-- 3부반 주중/주말 세부구분 (저장 전용 — 배치 엔진 미연동)
-- Production DB에는 이번 PR에서 직접 적용하지 않음 (migrate deploy는 별도 승인).

CREATE TYPE "ThirdBandSubgroup" AS ENUM ('WEEKDAY', 'WEEKEND');

ALTER TABLE "Caddy" ADD COLUMN "thirdBandSubgroup" "ThirdBandSubgroup";

CREATE INDEX "Caddy_thirdBandSubgroup_idx" ON "Caddy"("thirdBandSubgroup");
