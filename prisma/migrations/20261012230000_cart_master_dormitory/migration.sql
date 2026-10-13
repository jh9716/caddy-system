-- Cart master + Caddy.dormitoryResident. Additive only.
-- Date-local cart assignment table is out of scope (PR2).
-- Production migrate is out of scope for this PR (Draft / MERGE HOLD).

ALTER TABLE "Caddy"
ADD COLUMN "dormitoryResident" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "Caddy_dormitoryResident_idx" ON "Caddy"("dormitoryResident");

CREATE TYPE "CartKind" AS ENUM ('STANDARD', 'OTHER');
CREATE TYPE "CartOperationalStatus" AS ENUM ('ACTIVE', 'MAINTENANCE', 'DISABLED');

CREATE TABLE "Cart" (
    "id" SERIAL NOT NULL,
    "number" TEXT NOT NULL,
    "kind" "CartKind" NOT NULL DEFAULT 'STANDARD',
    "kindLabel" TEXT,
    "ownerCaddyId" INTEGER,
    "dormitoryOnly" BOOLEAN NOT NULL DEFAULT false,
    "operationalStatus" "CartOperationalStatus" NOT NULL DEFAULT 'ACTIVE',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Cart_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Cart_number_key" ON "Cart"("number");
CREATE UNIQUE INDEX "Cart_ownerCaddyId_key" ON "Cart"("ownerCaddyId");
CREATE INDEX "Cart_operationalStatus_idx" ON "Cart"("operationalStatus");
CREATE INDEX "Cart_dormitoryOnly_idx" ON "Cart"("dormitoryOnly");

ALTER TABLE "Cart"
ADD CONSTRAINT "Cart_ownerCaddyId_fkey"
FOREIGN KEY ("ownerCaddyId") REFERENCES "Caddy"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Cart"
ADD CONSTRAINT "Cart_dorm_owner_xor_check"
CHECK (NOT ("dormitoryOnly" AND "ownerCaddyId" IS NOT NULL));
