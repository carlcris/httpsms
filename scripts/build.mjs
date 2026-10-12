import { build } from "esbuild";
import { mkdir } from "node:fs/promises";

await mkdir("dist/functions", { recursive: true });
await build({
  entryPoints: ["netlify/functions/api.ts", "netlify/functions/dispatch-pending.ts"],
  outdir: "dist/functions",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  sourcemap: true,
});
console.info("Gateway functions compiled for Node.js 22. Netlify bundles production dependencies during deployment.");
