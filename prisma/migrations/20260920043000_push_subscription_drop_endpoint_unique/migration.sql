-- PushSubscription FINALIZE: drop legacy endpoint unique only.
-- Adds a non-unique endpoint lookup index.
-- Does not touch unique(userId, endpoint).
-- No DML. No table or column drop.

DROP INDEX "PushSubscription_endpoint_key";

CREATE INDEX "PushSubscription_endpoint_idx" ON "PushSubscription"("endpoint");
