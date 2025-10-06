-- CreateTable
CREATE TABLE "DailySchedule" (
    "id" SERIAL NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "available" INTEGER NOT NULL,
    "rest" INTEGER NOT NULL,
    "sick" INTEGER NOT NULL,
    "longSick" INTEGER NOT NULL,
    "duty" INTEGER NOT NULL,
    "marshal" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailySchedule_pkey" PRIMARY KEY ("id")
);
