-- Phase 12: alert triage transitions are audit-worthy (blueprint §11.5 lists
-- "alert status changes" alongside role changes/geofence CRUD/vehicle CRUD).
-- The worker/dashboard audit viewer (§7.3) needs to answer "who acknowledged
-- or resolved this alert, and when" — the ALERT_ACKNOWLEDGED / ALERT_RESOLVED
-- audit rows are written by alertService.updateAlertStatus on each transition.

-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'ALERT_ACKNOWLEDGED';
ALTER TYPE "AuditAction" ADD VALUE 'ALERT_RESOLVED';