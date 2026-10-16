import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "..", "web", "dist");
const dest = join(here, "..", "web");
if (!existsSync(src)) {
  console.warn("[tokensip] web dashboard not built yet (packages/web/dist missing) — skipping copy");
  process.exit(0);
}
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log("[tokensip] dashboard copied to packages/server/web");
