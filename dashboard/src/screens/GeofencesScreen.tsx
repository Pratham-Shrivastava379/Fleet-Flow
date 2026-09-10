import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "../api/api";

const CENTER = { lat: 12.9716, lng: 77.5946 };
const W = 800;
const H = 560;
const SPAN = 0.5;

/** Geofence authoring "map-drawing tool" (§7.2 item  5): a deterministic SVG
 *  schematic where clicking places the candidate circle center. Existing fences draw
 *  as circles; the preview circle tracks the live radius input. Offline-capable and
 *  swap-in for Google-Maps authoring without a data-model change. */
const hW = W / 2;
const hH = H / 2;
const hS = SPAN / 2;

function toSvg(lat: number, lng: number) {
  return {
    x: hW + ((lng - CENTER.lng) / hS) * hW,
    y: hH - ((lat - CENTER.lat) / hS) * hH,
  };
}
function fromSvg(x: number, y: number) {
  return {
    lat: CENTER.lat - ((y - hH) / hH) * hS,
    lng: CENTER.lng + ((x - hW) / hW) * hS,
  };
}
function clampValue(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

export function GeofencesScreen() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["geofences"],
    queryFn: () => api.geofences().then((r) => r.items),
  });
  const queryClient = useQueryClient();
  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: ["geofences"] });

  const [draftName, setDraftName] = useState("");
  const [draftRadius, setDraftRadius] = useState(500);
  const [draftCenter, setDraftCenter] = useState({ ...CENTER });
  const [alertOnEnter, setAlertOnEnter] = useState(false);
  const [alertOnExit, setAlertOnExit] = useState(false);

  const create = useMutation({
    mutationFn: () =>
      api.createGeofence({
        name: draftName.trim(),
        centerLat: draftCenter.lat,
        centerLng: draftCenter.lng,
        radiusM: draftRadius,
        alertOnEnter,
        alertOnExit,
      }),
    onSuccess: () => {
      setDraftName("");
      invalidate();
    },
  });

  const patch = useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id: number;
      body: Parameters<typeof api.updateGeofence>[1];
    }) => api.updateGeofence(id, body),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.deleteGeofence(id),
    onSuccess: invalidate,
  });

  // Per-fence enter/exit history (§4.2/§7.2 item 5 compliance trail). Loaded
  // on demand per fence (including soft-OFF'd ones — a removed fence keeps its
  // history), paginated client-side via the API's page/pageSize + type filter.
  const [historyFor, setHistoryFor] = useState<number | null>(null);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyType, setHistoryType] = useState("");
  const history = useQuery({
    queryKey: ["geofence-history", historyFor, historyPage, historyType],
    queryFn: () =>
      api.geofenceHistory(historyFor as number, {
        page: historyPage,
        pageSize: 10,
        eventType: (historyType === "ENTER" || historyType === "EXIT"
          ? historyType
          : undefined) as "ENTER" | "EXIT" | undefined,
      }),
    enabled: historyFor !== null,
  });
  const showHistory = (id: number) => {
    setHistoryFor(id);
    setHistoryPage(1);
    setHistoryType("");
  };

  const preview = toSvg(draftCenter.lat, draftCenter.lng);
  const previewPx = (draftRadius / hS) * hW;
  const fences = data ?? [];
  const active = fences.filter((g) => g.active);

  return (
    <div className="screen">
      <div className="screen-head">
        <h1>Geofences</h1>
      </div>
      {error && <div className="banner-error">{(error as Error).message}</div>}

      <div className="geofence-grid">
        <div className="geofence-map">
          <svg
            viewBox={"0 0 " + W + " " + H}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const x = ((e.clientX - rect.left) / rect.width) * W;
              const y = ((e.clientY - rect.top) / rect.height) * H;
              setDraftCenter(fromSvg(clampValue(x, 0, W), clampValue(y, 0, H)));
            }}
            style={{
              width: "100%",
              height: "420px",
              background: "#0d1b2a",
              borderRadius: 12,
              cursor: "crosshair",
            }}
            data-testid="geofence-map"
          >
            {[0.25, 0.5, 0.75].map((f) => (
              <g key={f} stroke="#1b263b" strokeWidth={1}>
                <line x1={0} y1={H * f} x2={W} y2={H * f} />
                <line x1={W * f} y1={0} x2={W * f} y2={H} />
              </g>
            ))}
            {active.map((g) => {
              const p = toSvg(g.centerLat, g.centerLng);
              const r = (g.radiusM / hS) * hW;
              return (
                <g key={g.id}>
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={r}
                    fill="rgba(46,196,182,0.15)"
                    stroke="#2ec4b6"
                    strokeWidth={1.5}
                  />
                  <text
                    x={p.x + r + 6}
                    y={p.y - r + 14}
                    fill="#e0e1dd"
                    fontSize={12}
                  >
                    {g.name}
                  </text>
                </g>
              );
            })}
            <circle
              cx={preview.x}
              cy={preview.y}
              r={previewPx}
              fill="rgba(255,214,10,0.12)"
              stroke="#ffd60a"
              strokeWidth={1.5}
              strokeDasharray="6 4"
            />
            <circle cx={preview.x} cy={preview.y} r={5} fill="#ffd60a" />
          </svg>
          <div className="map-footnote muted">
            Click the map to place the fence center (schematic view).
          </div>
        </div>

        <div className="geofence-form card">
          <h3>New fence</h3>
          <label>
            Name
            <input
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              data-testid="fence-name"
              placeholder="e.g. Depot"
            />
          </label>
          <label>
            Radius (m)
            <input
              type="number"
              min={10}
              max={100000}
              value={draftRadius}
              onChange={(e) => setDraftRadius(Number(e.target.value) || 0)}
              data-testid="fence-radius"
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={alertOnEnter}
              onChange={(e) => setAlertOnEnter(e.target.checked)}
            />
            Alert on enter
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={alertOnExit}
              onChange={(e) => setAlertOnExit(e.target.checked)}
            />
            Alert on exit
          </label>
          <button
            data-testid="fence-create"
            disabled={create.isPending || !draftName.trim() || draftRadius < 10}
            onClick={() => create.mutate()}
          >
            {create.isPending ? "Creating…" : "Create fence"}
          </button>
        </div>
      </div>

      {isLoading && <p className="muted">Loading fences…</p>}
      <div className="table-card">
        {fences.length === 0 && <p className="muted">No fences yet.</p>}
        {fences.map((g) => (
          <div className="row" key={g.id} data-testid="geofence-row">
            <div className="row-main">
              <div className="row-title">
                <span className="badge">{g.active ? "ACTIVE" : "OFF"}</span>
                <strong>{g.name}</strong>
                <span className="muted small">
                  {g.centerLat.toFixed(5)}, {g.centerLng.toFixed(5)} · r=
                  {g.radiusM}m
                </span>
              </div>
              <div className="muted small">
                {g.alertOnEnter ? "alert on enter" : ""}
                {g.alertOnEnter && g.alertOnExit ? " · " : ""}
                {g.alertOnExit ? "alert on exit" : ""}
              </div>
            </div>
            <div className="row-actions">
              <label className="check small-check">
                <input
                  type="checkbox"
                  checked={g.active}
                  onChange={(e) =>
                    patch.mutate({
                      id: g.id,
                      body: { active: e.target.checked },
                    })
                  }
                />
                active
              </label>
              <button
                className="ghost"
                onClick={() => showHistory(g.id)}
                data-testid={`fence-history-${g.id}`}
              >
                History
              </button>
              {g.active && (
                <button className="danger" onClick={() => remove.mutate(g.id)}>
                  Remove
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {historyFor !== null && (
        <div
          className="table-card history-panel"
          data-testid="geofence-history"
        >
          <div className="panel-head">
            <strong>
              History — {history.data?.fence.name ?? `fence #${historyFor}`}
            </strong>
            <div className="filters">
              <select
                value={historyType}
                onChange={(e) => {
                  setHistoryType(e.target.value);
                  setHistoryPage(1);
                }}
                aria-label="Filter crossings by type"
              >
                <option value="">Enter + exit</option>
                <option value="ENTER">Enter only</option>
                <option value="EXIT">Exit only</option>
              </select>
              <button onClick={() => setHistoryFor(null)}>Close</button>
            </div>
          </div>
          {history.isLoading && <p className="muted">Loading crossings…</p>}
          {history.error && (
            <div className="banner-error">
              {(history.error as Error).message}
            </div>
          )}
          {history.data && history.data.items.length === 0 && (
            <p className="muted">No crossings recorded for this fence yet.</p>
          )}
          {history.data?.items.map((ev) => (
            <div className="row" key={ev.id} data-testid="geofence-event-row">
              <div className="row-main">
                <div className="row-title">
                  <span
                    className={`badge ${ev.eventType === "ENTER" ? "evt-enter" : "evt-exit"}`}
                  >
                    {ev.eventType}
                  </span>
                  <strong>{ev.vehicle?.plate ?? "—"}</strong>
                  {ev.vehicle ? (
                    <span className="muted small">{ev.vehicle.model}</span>
                  ) : null}
                  {ev.trip ? (
                    <span className="muted small">
                      trip #{ev.trip.id}
                      {ev.trip.driver ? ` · ${ev.trip.driver.name}` : ""}
                    </span>
                  ) : null}
                </div>
                <div className="muted small">
                  {new Date(ev.occurredAt).toLocaleString()}
                </div>
              </div>
            </div>
          ))}
          {history.data && history.data.pages > 1 && (
            <div className="pager">
              <button
                disabled={historyPage <= 1}
                onClick={() => setHistoryPage((p) => Math.max(1, p - 1))}
              >
                ← Prev
              </button>
              <span className="muted small">
                Page {history.data.page} of {history.data.pages} (
                {history.data.total} crossings)
              </span>
              <button
                disabled={historyPage >= history.data.pages}
                onClick={() => setHistoryPage((p) => p + 1)}
              >
                Next →
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
