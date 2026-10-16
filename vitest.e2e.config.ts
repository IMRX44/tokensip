import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Browser tests for the dashboard. Requires a built dashboard (npm run build) and Chromium
// (npx playwright install chromium).
export default defineConfig({
  resolve: {
    alias: {
      "@tokensip/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["packages/web/e2e/**/*.e2e.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
