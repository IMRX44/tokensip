// Copies shared files into a workspace package before `npm pack` / `npm publish`.
//   node ../../scripts/prepack.mjs [--readme]
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = "https://github.com/IMRX44/tokensip";
const RAW = "https://raw.githubusercontent.com/IMRX44/tokensip/main";

const root = new URL("..", import.meta.url).pathname;
const pkg = process.cwd();
copyFileSync(join(root, "LICENSE"), join(pkg, "LICENSE"));

if (process.argv.includes("--readme")) {
  // npm cannot resolve repository-relative links, so make them absolute.
  const readme = readFileSync(join(root, "README.md"), "utf8")
    .replace(/(src=")(assets\/[^"]+)/g, `$1${RAW}/$2`)
    .replace(/\]\((?!https?:|#)([^)]+)\)/g, (_m, path) => `](${REPO}/blob/main/${path})`);
  writeFileSync(join(pkg, "README.md"), readme);
}
