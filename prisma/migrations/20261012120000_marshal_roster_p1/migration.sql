-- Marshal roster P1 (additive). Assignment.MARSHAL / DailyOpsDuty / MARSHAL_SUPPORT 와 분리.
-- Production migrate 실행은 이 PR에서 하지 않는다.

CREATE TABLE "MarshalProfile" (
    "id" SERIAL NOT NULL,
    "caddyId" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "startedOn" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarshalProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MarshalProfile_caddyId_key" ON "MarshalProfile"("caddyId");
CREATE INDEX "MarshalProfile_active_idx" ON "MarshalProfile"("active");

ALTER TABLE "MarshalProfile" ADD CONSTRAINT "MarshalProfile_caddyId_fkey" FOREIGN KEY ("caddyId") REFERENCES "Caddy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
