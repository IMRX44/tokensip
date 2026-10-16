import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const target = process.env.TOKENSIP_DEV_API ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 800,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target, changeOrigin: false },
      "/healthz": { target },
    },
  },
});
