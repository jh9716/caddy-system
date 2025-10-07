-- CreateTable
CREATE TABLE "ScheduleExtraTag" (
    "id" SERIAL NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "caddyId" INTEGER NOT NULL,
    "tag" TEXT NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduleExtraTag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScheduleExtraTag_date_caddyId_idx" ON "ScheduleExtraTag"("date", "caddyId");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduleExtraTag_date_caddyId_tag_key" ON "ScheduleExtraTag"("date", "caddyId", "tag");
