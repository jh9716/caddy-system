-- PushSubscription same-device multi-user V1.
-- Index change only. Preserves existing rows.
-- No DML. No table or column drop.

DROP INDEX IF EXISTS "PushSubscription_endpoint_key";

CREATE UNIQUE INDEX "PushSubscription_userId_endpoint_key" ON "PushSubscription"("userId", "endpoint");

CREATE INDEX "PushSubscription_endpoint_idx" ON "PushSubscription"("endpoint");
