import { defineConfig } from "vite";

export default defineConfig({
  // GitHub Pages serves a project site under /<repo>/, so CI builds with
  // VITE_BASE=/Metang/. Unset locally, which keeps dev at the root.
  base: process.env.VITE_BASE ?? "/",
  server: {
    port: 5173,
    // getUserMedia requires a secure context. localhost counts as secure, so
    // plain http is fine for local dev; use `--host` + https for LAN testing.
    proxy: {
      "/ws": { target: "ws://localhost:8787", ws: true },
    },
  },
  build: { target: "es2022" },
});
