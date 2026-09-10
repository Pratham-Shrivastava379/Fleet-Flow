-- Enable PostGIS and add a stored generated geography column on Geofence.
-- The Float lat/lng columns remain the Prisma-facing fields; `center` is a
-- generated, immutable derivation used by ST_DWithin/ST_Distance queries.
CREATE EXTENSION IF NOT EXISTS postgis;

ALTER TABLE "Geofence"
  ADD COLUMN "center" geography(Point, 4326)
  GENERATED ALWAYS AS (
    ST_SetSRID(ST_MakePoint("centerLng", "centerLat"), 4326)::geography
  ) STORED;

CREATE INDEX "Geofence_center_gix" ON "Geofence" USING GIST ("center");