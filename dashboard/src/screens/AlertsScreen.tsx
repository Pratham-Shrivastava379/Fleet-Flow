import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "../api/api";
import type { AlertStatus } from "../api/api";

const TYPE_FILTERS = [
  "",
  "SOS",
  "GEOFENCE_ENTER",
  "GEOFENCE_EXIT",
  "OVERSPEED",
  "HARSH_BRAKING",
  "CRASH_DETECTED",
];
const STATUS_FILTERS = ["", "OPEN", "ACKNOWLEDGED", "RESOLVED"];

const STATUS_CLASS: Record<string, string> = {
  OPEN: "badge-open",
  ACKNOWLEDGED: "badge-ack",
  RESOLVED: "badge-resolved",
};

/** §7.2 item 1 — fleet-wide alert inbox: status + type filter chips, per-row
 *  acknowledge/resolve triage (actor+timestamp stamped server-side, §6.2),
 *  no page reload (React Query invalidation after each mutation). */
export function AlertsScreen() {
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ["alerts", status, type],
    queryFn: () =>
      api.alerts({
        status: status || undefined,
        type: type || undefined,
        pageSize: 50,
      }),
  });

  const triage = useMutation({
    mutationFn: ({ id, next }: { id: number; next: AlertStatus }) =>
      api.updateAlert(id, next),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["alerts"] }),
  });

  const statusLabel = (s: string) =>
    s === "OPEN" ? "Ack" : s === "ACKNOWLEDGED" ? "Resolve" : null;

  return (
    <div className="screen">
      <div className="screen-head">
        <h1>Alerts</h1>
        <div className="filters">
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            aria-label="Filter by status"
          >
            {STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>
                {s === "" ? "All statuses" : s}
              </option>
            ))}
          </select>
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            aria-label="Filter by type"
          >
            {TYPE_FILTERS.map((t) => (
              <option key={t} value={t}>
                {t === "" ? "All types" : t}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <div className="banner-error">
          Failed to load alerts: {(error as Error).message}
        </div>
      )}
      {isLoading && <p className="muted">Loading alerts…</p>}

      <div className="table-card">
        {data && data.items.length === 0 && (
          <p className="muted">No alerts match.</p>
        )}
        {data?.items.map((a) => (
          <div className="row" key={a.id} data-testid="alert-row">
            <div className="row-main">
              <div className="row-title">
                <span className={`badge ${STATUS_CLASS[a.status] ?? ""}`}>
                  {a.status}
                </span>
                <strong>{a.type}</strong>
                <span className="muted small">#{a.id}</span>
              </div>
              <div className="muted small">
                {a.detail ||
                  `Position ${a.lat.toFixed(5)}, ${a.lng.toFixed(5)}`}
                {a.tripId ? ` · trip #${a.tripId}` : ""}
              </div>
              <div className="muted small">
                {new Date(a.createdAt).toLocaleString()}
                {a.raisedBy
                  ? ` · raised by ${a.raisedBy.name} (${a.raisedBy.role})`
                  : ""}
                {a.acknowledgedBy ? ` · acked by ${a.acknowledgedBy.name}` : ""}
                {a.resolvedBy ? ` · resolved by ${a.resolvedBy.name}` : ""}
              </div>
            </div>
            <div className="row-actions">
              {statusLabel(a.status) && (
                <button
                  disabled={triage.isPending}
                  onClick={() =>
                    triage.mutate({
                      id: a.id,
                      next: a.status === "OPEN" ? "ACKNOWLEDGED" : "RESOLVED",
                    })
                  }
                >
                  {statusLabel(a.status)}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
