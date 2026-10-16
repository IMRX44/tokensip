import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Live tests talk to a real provider. They run only with:
//   TOKENSIP_LIVE_BASE_URL=https://api.example.com/v1 TOKENSIP_LIVE_API_KEY=... npm run test:live
export default defineConfig({
  resolve: {
    alias: {
      "@tokensip/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["packages/*/test/live/**/*.live.ts"],
    environment: "node",
    testTimeout: 180_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
