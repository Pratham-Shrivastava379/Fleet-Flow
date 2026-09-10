import { useEffect, useMemo, useState } from "react";
import {
  MapContainer,
  TileLayer,
  CircleMarker,
  Tooltip,
  useMap,
  useMapEvents,
} from "react-leaflet";
import "leaflet/dist/leaflet.css";
import type { LiveVehicle } from "../hooks/useLiveFleet";
import {
  DEFAULT_MAP_PROVIDER,
  selectMapProvider,
  type MapProvider,
} from "../lib/mapProvider";

export interface MapViewProps {
  vehicles: LiveVehicle[];
  selectedVehicleId: number | null;
  onSelect: (vehicleId: number) => void;
  /**
   * Map provider. Defaults to `osm` (OpenStreetMap, active).
   * `google` re-enables the DORMANT Google Maps path (also requires
   * `googleMapsApiKey`); `schematic` renders the offline SVG map.
   */
  mapProvider?: MapProvider;
  /** Google Maps JS API key — only consumed when provider is "google". */
  googleMapsApiKey?: string;
}

export const DEFAULT_CENTER = { lat: 12.9716, lng: 77.5946 }; // Bengaluru (demo fleet area)

/**
 * Map switch (product decision — OpenStreetMap primary, Google Maps DORMANT):
 * the default provider is OSM via Leaflet raster tiles (no API key, no vendor
 * account). Google Maps remains fully implemented but inert unless
 * `VITE_MAP_PROVIDER=google` AND `VITE_GOOGLE_MAPS_API_KEY` are both set
 * (see src/lib/mapProvider.ts for the selection policy). The deterministic
 * offline SVG schematic remains available via `VITE_MAP_PROVIDER=schematic`.
 * All three render the same markers from the same state.
 */
export function MapView(props: MapViewProps) {
  const { provider, googleMapsApiKey } = useMemo(
    () =>
      selectMapProvider({
        VITE_MAP_PROVIDER: props.mapProvider ?? DEFAULT_MAP_PROVIDER,
        VITE_GOOGLE_MAPS_API_KEY: props.googleMapsApiKey,
      }),
    [props.mapProvider, props.googleMapsApiKey],
  );

  if (provider === "google") {
    return (
      <GoogleMapView
        vehicles={props.vehicles}
        selectedVehicleId={props.selectedVehicleId}
        onSelect={props.onSelect}
        googleMapsApiKey={googleMapsApiKey}
      />
    );
  }
  if (provider === "schematic") {
    return <SimpleMapView {...props} />;
  }
  return <OsmMapView {...props} />;
}

// ---------- OpenStreetMap (ACTIVE — Leaflet raster tiles, no key) ----------

function OsmMapView({ vehicles, selectedVehicleId, onSelect }: MapViewProps) {
  const center = useMemo(() => centroid(vehicles), [vehicles]);
  return (
    <div className="simple-map" data-testid="osm-map">
      <MapContainer
        center={center}
        zoom={11}
        style={{ width: "100%", height: "100%" }}
      >
        <MapResizeHandler />
        <MapClickHandler onSelect={onSelect} />
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {vehicles.map((v) => {
          const fresh = Date.now() - new Date(v.recordedAt).getTime() < 60_000;
          const selected = selectedVehicleId === v.vehicleId;
          return (
            <CircleMarker
              key={v.vehicleId}
              center={[v.lat, v.lng]}
              radius={selected ? 12 : 9}
              pathOptions={{
                color: fresh ? "#0f766e" : "#b91c1c",
                fillColor: fresh ? "#2ec4b6" : "#e71d36",
                fillOpacity: 0.9,
                weight: selected ? 2 : 1,
              }}
              eventHandlers={{ click: () => onSelect(v.vehicleId) }}
            >
              <Tooltip direction="top" offset={[0, -10]}>
                <strong>{v.plate}</strong>
                {v.live ? " ●" : ""}
                <br />
                {v.driverName || `vehicle #${v.vehicleId}`} ·{" "}
                {v.speedKmh.toFixed(0)} km/h
                <br />
                {v.lat.toFixed(5)}, {v.lng.toFixed(5)}
              </Tooltip>
            </CircleMarker>
          );
        })}
      </MapContainer>
    </div>
  );
}

function MapResizeHandler() {
  const map = useMap();

  useEffect(() => {
    const resize = () => map.invalidateSize({ animate: false });
    const frame = window.requestAnimationFrame(resize);
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);

    observer?.observe(map.getContainer());
    window.addEventListener("resize", resize);

    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, [map]);

  return null;
}

/** Leaflet hook component: clicking empty map space clears the selection. */
function MapClickHandler({
  onSelect,
}: {
  onSelect: (vehicleId: number) => void;
}) {
  useMapEvents({ click: () => onSelect(-1) });
  return null;
}

// ---------- Google Maps (DORMANT — re-enable via VITE_MAP_PROVIDER=google) ----------

/**
 * Dormant Google Maps path. The @react-google-maps/api chunk is NOT loaded by
 * default: it is dynamically imported only when the provider is explicitly
 * "google" (VITE_MAP_PROVIDER=google + VITE_GOOGLE_MAPS_API_KEY), so the
 * active OSM build never ships or fetches it. A small wrapper is needed so the
 * `useJsApiLoader` hook is always called unconditionally inside the loaded
 * child (rules of hooks).
 */
function GoogleMapView(props: MapViewProps) {
  const [deps, setDeps] = useState<
    typeof import("@react-google-maps/api") | null
  >(null);
  useEffect(() => {
    let cancelled = false;
    void import("@react-google-maps/api")
      .then((m) => {
        if (!cancelled) setDeps(m);
      })
      .catch(() => {
        if (!cancelled) setDeps(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!deps) {
    // Chunk still loading, or the dep was removed entirely: fall back to OSM
    // (the active provider) rather than failing the fleet screen.
    return (
      <OsmMapView
        vehicles={props.vehicles}
        selectedVehicleId={props.selectedVehicleId}
        onSelect={props.onSelect}
      />
    );
  }
  return <GoogleMapLoaded deps={deps} {...props} />;
}

function GoogleMapLoaded({
  deps,
  vehicles,
  selectedVehicleId,
  onSelect,
  googleMapsApiKey,
}: MapViewProps & { deps: typeof import("@react-google-maps/api") }) {
  const { useJsApiLoader, GoogleMap, Marker } = deps;
  const center = useMemo(() => centroid(vehicles), [vehicles]);
  const { isLoaded, loadError } = useJsApiLoader({
    googleMapsApiKey: googleMapsApiKey ?? "",
  });

  if (loadError || !isLoaded) {
    // Key rejected or library still initializing: fall back to OSM.
    return (
      <OsmMapView
        vehicles={vehicles}
        selectedVehicleId={selectedVehicleId}
        onSelect={onSelect}
      />
    );
  }

  return (
    <GoogleMap
      mapContainerStyle={{ width: "100%", height: "100%" }}
      center={center}
      zoom={11}
      onClick={() => onSelect(-1)}
    >
      {vehicles.map((v) => (
        <Marker
          key={v.vehicleId}
          position={{ lat: v.lat, lng: v.lng }}
          label={{ text: v.plate, fontSize: "11px" }}
          opacity={selectedVehicleId === v.vehicleId ? 1 : 0.85}
          onClick={() => onSelect(v.vehicleId)}
        />
      ))}
    </GoogleMap>
  );
}

// ---------- deterministic offline SVG schematic (VITE_MAP_PROVIDER=schematic) ----------

function SimpleMapView({
  vehicles,
  selectedVehicleId,
  onSelect,
}: MapViewProps) {
  const center = centroid(vehicles);
  const W = 800;
  const H = 560;
  const spanLat = 0.5; // visible lat/lng window (~55km), schematic only
  const spanLng = 0.5;

  const project = (lat: number, lng: number) => ({
    x: W / 2 + ((lng - center.lng) / (spanLng / 2)) * (W / 2),
    y: H / 2 - ((lat - center.lat) / (spanLat / 2)) * (H / 2),
  });

  return (
    <div className="simple-map" data-testid="simple-map">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Live fleet map (offline schematic view)"
        style={{
          width: "100%",
          height: "100%",
          background: "#0d1b2a",
          borderRadius: 12,
        }}
      >
        {/* graticule */}
        {[0.25, 0.5, 0.75].map((f) => (
          <g key={f} stroke="#1b263b" strokeWidth={1}>
            <line x1={0} y1={H * f} x2={W} y2={H * f} />
            <line x1={W * f} y1={0} x2={W * f} y2={H} />
          </g>
        ))}
        <text x={16} y={28} fill="#778da9" fontSize={14}>
          OFFLINE SCHEMATIC MAP (VITE_MAP_PROVIDER=schematic)
        </text>

        {vehicles.map((v) => {
          const { x, y } = project(v.lat, v.lng);
          const selected = selectedVehicleId === v.vehicleId;
          const fresh = Date.now() - new Date(v.recordedAt).getTime() < 60_000;
          return (
            <g
              key={v.vehicleId}
              transform={`translate(${clamp(x, 20, W - 20)},${clamp(y, 20, H - 20)})`}
              onClick={() => onSelect(v.vehicleId)}
              style={{ cursor: "pointer" }}
            >
              {selected && (
                <circle r={16} fill="none" stroke="#ffd60a" strokeWidth={2} />
              )}
              <circle
                r={8}
                fill={fresh ? "#2ec4b6" : "#e71d36"}
                opacity={0.95}
              />
              <text
                x={12}
                y={-8}
                fill="#e0e1dd"
                fontSize={12}
                style={{ pointerEvents: "none" }}
              >
                {v.plate}
                {v.live ? " ●" : ""}
              </text>
            </g>
          );
        })}
        {vehicles.length === 0 && (
          <text x={W / 2 - 120} y={H / 2} fill="#778da9" fontSize={16}>
            No active trips yet…
          </text>
        )}
      </svg>
    </div>
  );
}

function centroid(vehicles: LiveVehicle[]) {
  if (vehicles.length === 0) return DEFAULT_CENTER;
  const lat = vehicles.reduce((s, v) => s + v.lat, 0) / vehicles.length;
  const lng = vehicles.reduce((s, v) => s + v.lng, 0) / vehicles.length;
  return { lat, lng };
}

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}
