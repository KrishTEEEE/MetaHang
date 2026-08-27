import { defineConfig } from "vite";

export default defineConfig({
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
