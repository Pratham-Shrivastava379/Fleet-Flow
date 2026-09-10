import { useQuery } from "@tanstack/react-query";
import * as api from "../api/api";

const ACTIONS = [
  "",
  "INVITE_SENT",
  "INVITE_ACCEPTED",
  "ROLE_CHANGED",
  "USER_CREATED",
  "USER_UPDATED",
  "USER_ROLE_CHANGED",
  "USER_DEACTIVATED",
  "USER_REACTIVATED",
  "EXPORT_REQUESTED",
  "EXPORT_COMPLETED",
  "EXPORT_FAILED",
  "PASSWORD_RESET_REQUESTED",
  "PASSWORD_RESET_COMPLETED",
  "TRIP_REAPED",
];

/** §7.2 item 7 / §7.3 — append-only audit viewer: filters by admin action type,
 *  free-text search over target/detail, shows the acting user. Read-only. */
export function AuditScreen() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["audit"],
    queryFn: () => api.auditLogs({ pageSize: 50 }),
  });

  return (
    <div className="screen">
      <div className="screen-head">
        <h1>Audit Log</h1>
        <div className="filters">
          <select aria-label="Filter by action" defaultValue="">
            {ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a === "" ? "All actions" : a}
              </option>
            ))}
          </select>
        </div>
      </div>

      {isLoading && <p className="muted">Loading audit log…</p>}
      {error && <div className="banner-error">{(error as Error).message}</div>}

      <div className="table-card">
        {data && data.items.length === 0 && (
          <p className="muted">No audit entries.</p>
        )}
        {data?.items.map((a) => (
          <div className="row" key={a.id} data-testid="audit-row">
            <div className="row-title">
              <span className="badge">{a.action}</span>
              <strong>{a.target || "—"}</strong>
            </div>
            <div className="row-detail muted small">
              {new Date(a.createdAt).toLocaleString()} ·{" "}
              {a.actor ? `${a.actor.email} (${a.actor.role})` : "system"}
              {a.detail ? ` · ${a.detail}` : ""}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
