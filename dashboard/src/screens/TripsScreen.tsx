import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "../api/api";
import type { ExportJobRow } from "../api/api";

const STATUS_FILTERS = ["", "ACTIVE", "COMPLETED", "CANCELLED"];

function fmtTime(iso?: string | null) {
  return iso ? new Date(iso).toLocaleString() : "—";
}

function TripRow({ t }: { t: api.Trip }) {
  const raw = t as { driverId?: number; _count?: { pings?: number } };
  return (
    <div className="row">
      <div className="row-main">
        <div className="row-title">
          <span className="badge">{t.status}</span>
          <strong>Trip #{t.id}</strong>
          <span className="muted small">
            {t.vehicle?.plate ?? "—"} ·{" "}
            {t.driver?.name ?? `driver #${raw.driverId ?? ""}`}
          </span>
        </div>
        <div className="muted small">
          {fmtTime(t.startedAt)} → {fmtTime(t.finishedAt)}
        </div>
      </div>
      <div className="row-stats">
        <span title="distance">{(t.distanceKmh ?? 0).toFixed(1)} km</span>
        <span title="avg speed">{(t.avgSpeedKmh ?? 0).toFixed(0)} km/h</span>
        <span title="duration">
          {Math.round((t.durationSeconds ?? 0) / 60)} min
        </span>
        <span title="pings">{raw._count?.pings ?? 0} pings</span>
      </div>
    </div>
  );
}
/** items 2–3 of §7.2 — fleet-wide trip list + async CSV export. The Export
 *  button enqueues an exports job (POST /api/reports, 202), then polls
 *  GET /api/reports/:id until DONE and downloads the artifact (§7.2 item 3:
 *  "download link appears when ready, polled"). */
export function TripsScreen() {
  const [status, setStatus] = useState("");
  const [exportType, setExportType] = useState<api.ExportType>("TRIPS_CSV");
  const [jobs, setJobs] = useState<Record<number, ExportJobRow>>({});
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ["trips", status],
    queryFn: () => api.trips({ status: status || undefined, pageSize: 50 }),
  });

  const exports = useQuery({
    queryKey: ["exports"],
    queryFn: () => api.recentExports().then((r) => r.items),
    refetchInterval: 2000,
  });

  // Poll non-terminal jobs until they finish, then refresh the exports list.
  useEffect(() => {
    const activeJobs = Object.values(jobs).filter(
      (j) => j.status === "PENDING" || j.status === "RUNNING",
    );
    if (activeJobs.length === 0) return;
    const id = window.setInterval(async () => {
      let changed = false;
      const updates: Record<number, ExportJobRow> = {};
      for (const j of activeJobs) {
        try {
          const { job } = await api.getExport(j.id);
          updates[j.id] = job;
          if (job.status !== "PENDING" && job.status !== "RUNNING")
            changed = true;
        } catch {
          /* keep polling */
        }
      }
      setJobs((prev) => ({ ...prev, ...updates }));
      if (changed)
        void queryClient.invalidateQueries({ queryKey: ["exports"] });
    }, 1500);
    return () => window.clearInterval(id);
  }, [jobs, queryClient]);

  const requestExport = useMutation({
    mutationFn: () => api.createExport(exportType, status ? { status } : {}),
    onSuccess: ({ job }) => {
      setJobs((prev) => ({ ...prev, [job.id]: job }));
      void queryClient.invalidateQueries({ queryKey: ["exports"] });
    },
  });

  const download = async (j: ExportJobRow) => {
    try {
      const csv = await api.downloadExport(j.id);
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `fleetflow-${j.type.toLowerCase()}-${j.id}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      window.alert((err as Error).message);
    }
  };

  return (
    <div className="screen">
      <div className="screen-head">
        <h1>Trips</h1>
        <div className="filters">
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            aria-label="Filter trips by status"
          >
            {STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>
                {s === "" ? "All statuses" : s}
              </option>
            ))}
          </select>
          <select
            value={exportType}
            onChange={(e) => setExportType(e.target.value as api.ExportType)}
            aria-label="Export type"
          >
            <option value="TRIPS_CSV">Trips CSV</option>
            <option value="ALERTS_CSV">Alerts CSV</option>
            <option value="GEOFENCE_HISTORY">Geofence events</option>
          </select>
          <button
            data-testid="export-btn"
            onClick={() => requestExport.mutate()}
            disabled={requestExport.isPending}
          >
            {requestExport.isPending ? "Starting…" : "Export CSV"}
          </button>
        </div>
      </div>

      {(isLoading || requestExport.isPending) && (
        <p className="muted">Loading…</p>
      )}
      {error && (
        <div className="banner-error">
          Failed to load trips: {(error as Error).message}
        </div>
      )}

      <div className="table-card">
        {data && data.items.length === 0 && (
          <p className="muted">No trips match.</p>
        )}
        {data?.items.map((t) => (
          <TripRow key={t.id} t={t} />
        ))}
      </div>

      <section className="exports-panel">
        <h2>Recent exports</h2>
        {(exports.data ?? []).length === 0 && (
          <p className="muted">No exports yet — click Export CSV above.</p>
        )}
        {(exports.data ?? []).map((j) => (
          <div className="row" key={j.id} data-testid="export-row">
            <div className="row-main">
              <div className="row-title">
                <span className={`badge badge-${j.status.toLowerCase()}`}>
                  {j.status}
                </span>
                <strong>{j.type}</strong>
                <span className="muted small">
                  #{j.id} · {new Date(j.createdAt).toLocaleString()}
                </span>
              </div>
              <div className="muted small">
                {j.error ?? (j.resultUrl ? "ready to download" : "")}
              </div>
            </div>
            <div className="row-actions">
              {j.status === "DONE" && (
                <button onClick={() => download(j)}>Download</button>
              )}
              {j.status === "PENDING" && (
                <span className="muted small">…in queue</span>
              )}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
