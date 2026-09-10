/**
 * Map provider selection (product decision: OpenStreetMap is the active map,
 * Google Maps is DORMANT until further notice).
 *
 * Policy:
 *  - The default provider is `osm` (Leaflet + OpenStreetMap raster tiles) — no
 *    API key required, no vendor account.
 *  - Google Maps only activates when BOTH `VITE_MAP_PROVIDER=google` AND
 *    `VITE_GOOGLE_MAPS_API_KEY` are set. The key alone is NOT enough — this is
 *    the "dormant until further notice" guarantee: a leftover key in `.env`
 *    cannot silently re-enable the Google path.
 *  - `schematic` renders the deterministic offline SVG map (no network).
 */
export type MapProvider = "osm" | "google" | "schematic";

export const DEFAULT_MAP_PROVIDER: MapProvider = "osm";

export interface MapProviderEnv {
  VITE_MAP_PROVIDER?: string;
  VITE_GOOGLE_MAPS_API_KEY?: string;
}

export interface MapProviderChoice {
  provider: MapProvider;
  /** Only non-undefined when the Google (dormant) path is explicitly requested. */
  googleMapsApiKey?: string;
}

export function selectMapProvider(env: MapProviderEnv): MapProviderChoice {
  const requested = env.VITE_MAP_PROVIDER;
  if (requested === "google") {
    // Google Maps stays dormant unless explicitly opted in WITH a key.
    if (env.VITE_GOOGLE_MAPS_API_KEY) {
      return {
        provider: "google",
        googleMapsApiKey: env.VITE_GOOGLE_MAPS_API_KEY,
      };
    }
    return { provider: "osm" };
  }
  if (requested === "schematic") {
    return { provider: "schematic" };
  }
  // Default (and any unknown value): OpenStreetMap.
  return { provider: "osm" };
}
