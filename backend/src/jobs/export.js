/**
 * Phase 12: exports queue consumer.
 *
 * Runs `exportService.runExportJob` — status transitions (PENDING → RUNNING →
 * DONE/FAILED) and CSV generation live in the service so they're testable
 * without BullMQ, mirroring how retention/partition-maintenance jobs are
 * thin wrappers over their service-layer logic.
 */
import { runExportJob } from "../services/exportService.js";

export default async function exportJobRunner(data) {
  const done = await runExportJob(data);
  return { exportJobId: done.id, status: done.status, resultUrl: done.resultUrl };
}
