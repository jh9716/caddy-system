-- DevicePushToken V1 (Android FCM). Additive. No PushSubscription DML/DDL.

CREATE TYPE "DevicePushPlatform" AS ENUM ('ANDROID');

CREATE TABLE "DevicePushToken" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "token" TEXT NOT NULL,
    "platform" "DevicePushPlatform" NOT NULL DEFAULT 'ANDROID',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastFailureAt" TIMESTAMP(3),

    CONSTRAINT "DevicePushToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DevicePushToken_userId_token_key" ON "DevicePushToken"("userId", "token");
CREATE INDEX "DevicePushToken_token_idx" ON "DevicePushToken"("token");
CREATE INDEX "DevicePushToken_userId_idx" ON "DevicePushToken"("userId");

ALTER TABLE "DevicePushToken" ADD CONSTRAINT "DevicePushToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
