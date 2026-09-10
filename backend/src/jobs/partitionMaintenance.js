import { prisma } from "../prisma.js";

/**
 * Create monthly partitions on the partitioned parent "LocationPing" ahead of
 * time (blueprint §4.4 partition-maintenance). Postgres requires a partition to
 * exist for any month into which a row will land; this job keeps `monthsAhead`
 * months (incl. the current) provisioned so fleet pings never fail on a missing
 * partition, and reruns are idempotent (CREATE TABLE ... IF NOT EXISTS PARTITION OF).
 * Table/date names are generated from local date math, never user input.
 */
export function monthLabel(offset) {
  const d = new Date();
  const y = d.getFullYear();
  const m = d.getMonth() + 1 + offset;
  const yy = y + Math.floor((m - 1) / 12);
  const mm = ((m - 1) % 12) + 1;
  return `${yy}_${String(mm).padStart(2, "0")}`;
}

function partitionName(offset) {
  return `LocationPing_${monthLabel(offset)}`;
}

function monthStart(offset) {
  const d = new Date();
  const m = d.getMonth() + 1 + offset;
  const yy = d.getFullYear() + Math.floor((m - 1) / 12);
  const mm = ((m - 1) % 12) + 1;
  return `${yy}-${String(mm).padStart(2, "0")}-01`;
}

export async function ensureLocationPingPartitions(monthsAhead = 4) {
  const created = [];
  for (let i = 0; i < monthsAhead; i++) {
    const name = partitionName(i);
    const start = monthStart(i);
    const end = monthStart(i + 1);
    // Exact relname match (to_regclass would case-fold the name and miss the
    // mixed-case partition, causing needless/overlapping CREATE attempts).
    const existing = await prisma.$queryRawUnsafe("SELECT 1 FROM pg_class WHERE relname = $1", name);
    if (existing.length === 0) {
      await prisma.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS "${name}" PARTITION OF "LocationPing" FOR VALUES FROM ('${start}') TO ('${end}')`,
      );
      created.push(name);
    }
  }
  return { created, monthsAhead };
}

/** Job handler. */
export default async function partitionMaintenanceJob(data = {}) {
  const monthsAhead = Number(data?.monthsAhead) || 4;
  return ensureLocationPingPartitions(monthsAhead);
}
