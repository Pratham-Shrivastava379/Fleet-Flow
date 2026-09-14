import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Phase 11: the SPA is served same-origin with the
// backend - Vite proxies /api and /ws to the Express/WS server. This keeps the
// web auth cookie same-site in local dev (no SSR/external CDN needed yet) and
// matches the preferred same-origin production serving (§13.2).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:3000", changeOrigin: true },
      "/ws": { target: "http://localhost:3000", ws: true, changeOrigin: true },
    },
  },
  test: {
    environment: "node",
    include: ["src/test/**/*.test.ts"],
  },
});
