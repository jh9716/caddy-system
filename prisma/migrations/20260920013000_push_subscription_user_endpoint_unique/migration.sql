-- PushSubscription PREPARE: additive unique(userId, endpoint) only.
-- Keeps the original endpoint unique index.
-- No DML. No table or column drop.

CREATE UNIQUE INDEX "PushSubscription_userId_endpoint_key" ON "PushSubscription"("userId", "endpoint");
