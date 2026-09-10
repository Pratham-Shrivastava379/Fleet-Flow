import { useMemo, useState } from "react";
import { useLiveFleet } from "../hooks/useLiveFleet";
import { MapView } from "../components/MapView";
import { selectMapProvider } from "../lib/mapProvider";

const STATUS_LABEL: Record<string, string> = {
  connecting: "connecting…",
  live: "live",
  reconnecting: "reconnecting…",
  closed: "offline",
};

/** Phase 11/12: near-real-time fleet map + vehicle list (§15.11). Rendered as a
 *  content pane inside the dashboard shell (App.tsx owns nav + sign-out). */
export function LiveFleetScreen() {
  const { vehicles, status, loading, error, lastEventAt, refreshes } =
    useLiveFleet();
  const [selected, setSelected] = useState<number | null>(null);
  // Map provider: OpenStreetMap by default; Google Maps stays dormant unless
  // VITE_MAP_PROVIDER=google + VITE_GOOGLE_MAPS_API_KEY are both set.
  const { provider: mapProvider, googleMapsApiKey } = useMemo(
    () =>
      selectMapProvider({
        VITE_MAP_PROVIDER: import.meta.env.VITE_MAP_PROVIDER as
          string | undefined,
        VITE_GOOGLE_MAPS_API_KEY: import.meta.env.VITE_GOOGLE_MAPS_API_KEY as
          string | undefined,
      }),
    [],
  );

  const sel = vehicles.find((v) => v.vehicleId === selected) ?? null;

  return (
    <div className="fleet-screen">
      <div className="fleet-toolbar">
        <span
          className={`ws-badge ws-${status}`}
          data-testid="ws-status"
          title={lastEventAt ? `last event ${lastEventAt}` : "no events yet"}
        >
          ● {STATUS_LABEL[status] ?? status}
        </span>
        <span className="muted small">
          {vehicles.length} active vehicle{vehicles.length === 1 ? "" : "s"}
          {refreshes > 0
            ? ` · ${refreshes} refetch${refreshes === 1 ? "" : "es"} from batch/trip events`
            : ""}
        </span>
      </div>

      {error && (
        <div className="banner-error">
          Failed to load active trips: {error.message}
        </div>
      )}

      <main className="fleet-main">
        <section className="map-panel">
          {loading ? (
            <div className="map-loading">Loading active trips…</div>
          ) : (
            <MapView
              vehicles={vehicles}
              selectedVehicleId={selected}
              onSelect={setSelected}
              mapProvider={mapProvider}
              googleMapsApiKey={googleMapsApiKey}
            />
          )}
        </section>

        <aside className="vehicle-list">
          <h2>Vehicles</h2>
          {vehicles.length === 0 && !loading && (
            <p className="muted">No active trips right now.</p>
          )}
          <ul>
            {vehicles.map((v) => (
              <li
                key={v.vehicleId}
                className={selected === v.vehicleId ? "selected" : ""}
                onClick={() => setSelected(v.vehicleId)}
              >
                <div className="v-plate">
                  {v.plate}{" "}
                  {v.live && (
                    <span className="live-dot" title="live update received">
                      ●
                    </span>
                  )}
                </div>
                <div className="muted">
                  {v.driverName || `vehicle #${v.vehicleId}`} ·{" "}
                  {v.speedKmh.toFixed(0)} km/h
                </div>
                <div className="muted small">
                  {v.lat.toFixed(5)}, {v.lng.toFixed(5)} ·{" "}
                  {new Date(v.recordedAt).toLocaleTimeString()}
                </div>
              </li>
            ))}
          </ul>

          {sel && (
            <div className="vehicle-detail" data-testid="vehicle-detail">
              <h3>{sel.plate}</h3>
              <p>Driver: {sel.driverName || `#${sel.vehicleId}`}</p>
              <p>
                Position: {sel.lat.toFixed(5)}, {sel.lng.toFixed(5)}
              </p>
              <p>Speed: {sel.speedKmh.toFixed(0)} km/h</p>
              <p>Trip: #{sel.tripId}</p>
              <p className="muted">
                Last update: {new Date(sel.recordedAt).toLocaleString()}
              </p>
              <button onClick={() => setSelected(null)}>Close</button>
            </div>
          )}
        </aside>
      </main>
    </div>
  );
}
