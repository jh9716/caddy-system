-- Chat room notification preference V1. Additive only.
CREATE TYPE "ChatRoomNotificationMode" AS ENUM ('ALL', 'MENTIONS', 'OFF');

CREATE TABLE "ChatRoomNotificationPreference" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "roomId" TEXT NOT NULL,
    "mode" "ChatRoomNotificationMode" NOT NULL DEFAULT 'ALL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatRoomNotificationPreference_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChatRoomNotificationPreference_userId_roomId_key"
  ON "ChatRoomNotificationPreference"("userId", "roomId");

CREATE INDEX "ChatRoomNotificationPreference_userId_idx"
  ON "ChatRoomNotificationPreference"("userId");

CREATE INDEX "ChatRoomNotificationPreference_roomId_idx"
  ON "ChatRoomNotificationPreference"("roomId");

ALTER TABLE "ChatRoomNotificationPreference"
  ADD CONSTRAINT "ChatRoomNotificationPreference_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
