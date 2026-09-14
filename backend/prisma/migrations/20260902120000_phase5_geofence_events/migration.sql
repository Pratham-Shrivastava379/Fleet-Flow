-- Phase 5: geofence evaluation moves server-side/async.
-- Adds: GeofenceEventType enum + GeofenceEvent crossing audit table,
-- Geofence.alertOnEnter/alertOnExit flags, FleetLastPosition materialized
-- last-known-position table (with a Prisma-invisible PostGIS `geo` column).
--
-- Prisma-invisible artifact handling:
--  * The generated diff wanted to DROP `Geofence.center` (PostGIS stored-
--    generated column, invisible to the Prisma schema) — removed; re-asserted
--    idempotently at the bottom instead.
--  * The generated diff wanted to rewrite LocationPing's PK to (id) — invalid
--    on a RANGE("createdAt")-partitioned table (PK must include the partition
--    key); removed. The composite PK (id, "createdAt") from the phase4
--    partitioning migration stands; schema.prisma's plain `id @id` stays a
--    documented approximation.

-- CreateEnum
CREATE TYPE "GeofenceEventType" AS ENUM ('ENTER', 'EXIT');

-- AlterTable
ALTER TABLE "Geofence" ADD COLUMN     "alertOnEnter" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "alertOnExit" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "GeofenceEvent" (
    "id" SERIAL NOT NULL,
    "geofenceId" INTEGER NOT NULL,
    "vehicleId" INTEGER NOT NULL,
    "tripId" INTEGER,
    "eventType" "GeofenceEventType" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GeofenceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FleetLastPosition" (
    "vehicleId" INTEGER NOT NULL,
    "tripId" INTEGER NOT NULL,
    "driverId" INTEGER NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "speedKmh" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "headingDeg" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FleetLastPosition_pkey" PRIMARY KEY ("vehicleId")
);

-- CreateIndex
CREATE INDEX "GeofenceEvent_geofenceId_occurredAt_idx" ON "GeofenceEvent"("geofenceId", "occurredAt");

-- CreateIndex
CREATE INDEX "GeofenceEvent_vehicleId_occurredAt_idx" ON "GeofenceEvent"("vehicleId", "occurredAt");

-- AddForeignKey
ALTER TABLE "GeofenceEvent" ADD CONSTRAINT "GeofenceEvent_geofenceId_fkey" FOREIGN KEY ("geofenceId") REFERENCES "Geofence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeofenceEvent" ADD CONSTRAINT "GeofenceEvent_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeofenceEvent" ADD CONSTRAINT "GeofenceEvent_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FleetLastPosition" ADD CONSTRAINT "FleetLastPosition_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FleetLastPosition" ADD CONSTRAINT "FleetLastPosition_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FleetLastPosition" ADD CONSTRAINT "FleetLastPosition_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Prisma-invisible PostGIS artifacts (see header). IF NOT EXISTS keeps both
-- statements idempotent in case the artifacts survived.
CREATE EXTENSION IF NOT EXISTS postgis;

-- FleetLastPosition.geo: stored-generated geography column so
-- future proximity queries ("vehicles near X") can use the GIST index without
-- re-touching this table.
ALTER TABLE "FleetLastPosition" ADD COLUMN IF NOT EXISTS "geo" geography(Point, 4326)
  GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint("lng", "lat"), 4326)::geography) STORED;
CREATE INDEX IF NOT EXISTS "FleetLastPosition_geo_gix" ON "FleetLastPosition" USING GIST ("geo");

-- Re-assert Geofence.center + its GIST index (invisible to the Prisma schema).
ALTER TABLE "Geofence" ADD COLUMN IF NOT EXISTS "center" geography(Point, 4326)
  GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint("centerLng", "centerLat"), 4326)::geography) STORED;
CREATE INDEX IF NOT EXISTS "Geofence_center_gix" ON "Geofence" USING GIST ("center");
