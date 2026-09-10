import { describe, expect, it } from "vitest";
import { DEFAULT_MAP_PROVIDER, selectMapProvider } from "../lib/mapProvider";

describe("selectMapProvider", () => {
  it("defaults to OpenStreetMap with no env at all", () => {
    expect(selectMapProvider({})).toEqual({ provider: "osm" });
    expect(DEFAULT_MAP_PROVIDER).toBe("osm");
  });

  it("resolves an explicit osm provider", () => {
    expect(selectMapProvider({ VITE_MAP_PROVIDER: "osm" })).toEqual({
      provider: "osm",
    });
  });

  it("resolves the offline schematic provider", () => {
    expect(selectMapProvider({ VITE_MAP_PROVIDER: "schematic" })).toEqual({
      provider: "schematic",
    });
  });

  it("keeps Google Maps DORMANT: a key alone never activates it", () => {
    // Leftover key in .env must not silently re-enable the Google path.
    expect(
      selectMapProvider({ VITE_GOOGLE_MAPS_API_KEY: "AIza-leftover" }),
    ).toEqual({ provider: "osm" });
  });

  it("keeps Google Maps DORMANT: provider=google without a key falls back to osm", () => {
    expect(selectMapProvider({ VITE_MAP_PROVIDER: "google" })).toEqual({
      provider: "osm",
    });
  });

  it("activates Google only when provider=google AND a key is present", () => {
    expect(
      selectMapProvider({
        VITE_MAP_PROVIDER: "google",
        VITE_GOOGLE_MAPS_API_KEY: "AIza-explicit-opt-in",
      }),
    ).toEqual({
      provider: "google",
      googleMapsApiKey: "AIza-explicit-opt-in",
    });
  });

  it("treats unknown provider values as osm", () => {
    expect(selectMapProvider({ VITE_MAP_PROVIDER: "bing" })).toEqual({
      provider: "osm",
    });
  });
});
