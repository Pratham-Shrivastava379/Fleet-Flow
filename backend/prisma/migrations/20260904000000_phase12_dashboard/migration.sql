-- Phase 12: web dashboard backend support (blueprint §15.12).
--  - Alert triage metadata (§6.2 target Alert shape): raised/acknowledged/resolved actor+time
--  - Vehicle default-driver assignment + maintenance note (§7.2 item 4)
--  - ExportJob table for async CSV exports (§6.2; worker consumes, §4.4)
--  - UserStatus deactivation flag (§5.1 account activation semantics for the Users screen)
--  - AuditAction values for user admin + export lifecycle
--
-- NOTE: generated via `prisma migrate diff` (create-only pattern from
-- IMPLEMENTATION_PROGRESS.md). The diff suggested dropping the Prisma-invisible
-- PostGIS columns ("Geofence"."center", "FleetLastPosition"."geo") and changing
-- the partitioned "LocationPing" primary key — all three are false diffs (the
-- columns/PK are managed by raw-SQL migrations phase1/phase4/phase5) and are
-- intentionally NOT present here.

-- CreateEnum
CREATE TYPE "ExportJobType" AS ENUM ('TRIPS_CSV', 'ALERTS_CSV', 'GEOFENCE_HISTORY');

-- CreateEnum
CREATE TYPE "ExportJobStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'FAILED');

-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'USER_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'USER_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'USER_ROLE_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE 'USER_DEACTIVATED';
ALTER TYPE "AuditAction" ADD VALUE 'USER_REACTIVATED';
ALTER TYPE "AuditAction" ADD VALUE 'EXPORT_REQUESTED';
ALTER TYPE "AuditAction" ADD VALUE 'EXPORT_COMPLETED';
ALTER TYPE "AuditAction" ADD VALUE 'EXPORT_FAILED';

-- AlterTable
ALTER TABLE "Alert" ADD COLUMN     "acknowledgedAt" TIMESTAMP(3),
ADD COLUMN     "acknowledgedById" INTEGER,
ADD COLUMN     "raisedById" INTEGER,
ADD COLUMN     "resolvedAt" TIMESTAMP(3),
ADD COLUMN     "resolvedById" INTEGER;

-- AlterTable
ALTER TABLE "Vehicle" ADD COLUMN     "defaultDriverId" INTEGER,
ADD COLUMN     "maintenanceNote" TEXT;

-- CreateTable
CREATE TABLE "ExportJob" (
    "id" SERIAL NOT NULL,
    "requestedBy" INTEGER NOT NULL,
    "type" "ExportJobType" NOT NULL,
    "status" "ExportJobStatus" NOT NULL DEFAULT 'PENDING',
    "params" JSONB NOT NULL DEFAULT '{}',
    "resultUrl" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ExportJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserStatus" (
    "userId" INTEGER NOT NULL,
    "deactivatedAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "UserStatus_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE INDEX "ExportJob_requestedBy_createdAt_idx" ON "ExportJob"("requestedBy", "createdAt");

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_defaultDriverId_fkey" FOREIGN KEY ("defaultDriverId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_raisedById_fkey" FOREIGN KEY ("raisedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_acknowledgedById_fkey" FOREIGN KEY ("acknowledgedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExportJob" ADD CONSTRAINT "ExportJob_requestedBy_fkey" FOREIGN KEY ("requestedBy") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserStatus" ADD CONSTRAINT "UserStatus_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
