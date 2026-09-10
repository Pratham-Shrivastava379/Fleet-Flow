-- Phase 4: make location_pings a monthly RANGE(createdAt) partitioned table and
-- add the IdempotencyKey dedup table.
--
-- Postgres note (see IMPLEMENTATION_PROGRESS.md "Phase 4 notes"): a unique/PK on
-- a RANGE-partitioned table must include the partition key, so a global unique on
-- `idempotencyKey` canNOT coexist on "LocationPing". The global-unique dedup
-- constraint therefore lives on the new "IdempotencyKey" table (blueprint §1.1
-- pattern preserved); addPing gates on it before writing the partitioned row.

-- 1) IdempotencyKey (global unique dedup gate)
CREATE TABLE "IdempotencyKey" (
    id SERIAL NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "tripId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY (id)
);
CREATE UNIQUE INDEX "IdempotencyKey_idempotencyKey_key" ON "IdempotencyKey"("idempotencyKey");
CREATE INDEX "IdempotencyKey_tripId_idx" ON "IdempotencyKey"("tripId");
ALTER TABLE "IdempotencyKey" ADD CONSTRAINT "IdempotencyKey_tripId_fkey"
    FOREIGN KEY ("tripId") REFERENCES "Trip"(id) ON DELETE CASCADE ON UPDATE CASCADE;

-- 2) Rebuild LocationPing as a partitioned parent (dev/demo: no precious data —
--    the same migration drops the old flat table; existing rows are non-critical
--    and tests clean them anyway).
DROP TABLE IF EXISTS "LocationPing";

CREATE TABLE "LocationPing" (
    id SERIAL NOT NULL,
    "tripId" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    lat DOUBLE PRECISION NOT NULL,
    lng DOUBLE PRECISION NOT NULL,
    "speedKmh" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "headingDeg" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "accuracyM" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LocationPing_pkey" PRIMARY KEY (id, "createdAt")
) PARTITION BY RANGE ("createdAt");

CREATE INDEX "LocationPing_tripId_recordedAt_idx" ON "LocationPing" ("tripId", "recordedAt");
ALTER TABLE "LocationPing" ADD CONSTRAINT "LocationPing_tripId_fkey"
    FOREIGN KEY ("tripId") REFERENCES "Trip"(id) ON DELETE CASCADE ON UPDATE CASCADE;

-- 3) Seed the CURRENT month's partition (the partition-maintenance worker keeps
--    several months ahead). Only the current month is created here so the job's
--    "creates next month's partition" done-condition is observable in tests.
DO $$
DECLARE
    start_m timestamptz;
    nm text;
BEGIN
    start_m := date_trunc('month', now());
    nm := 'LocationPing_' || to_char(start_m, 'YYYY_MM');
    EXECUTE format(
        'CREATE TABLE %I PARTITION OF "LocationPing" FOR VALUES FROM (%L) TO (%L)',
        nm, start_m, start_m + interval '1 month'
    );
END $$;
