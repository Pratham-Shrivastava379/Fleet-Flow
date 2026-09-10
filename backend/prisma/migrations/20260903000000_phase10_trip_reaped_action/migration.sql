-- Phase 10: TRIP_REAPED audit action (stale-trip reaper, blueprint §8.1).
-- Additive only — safe for the Prisma-invisible PostGIS Geofence.center column
-- (no table/column shape changes; see IMPLEMENTATION notes in
-- the auth_hardening migration's re-assert block
-- for the standing protocol).
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'TRIP_REAPED';
