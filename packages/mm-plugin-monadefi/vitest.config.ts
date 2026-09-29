import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const lib = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));

export default defineConfig({
  // zod: @app/risk has no node_modules of its own in this checkout, so it resolves zod from this package.
  resolve: { alias: { "@app/perpl": lib("perpl/src/index.ts"), "@app/risk": lib("risk/src/index.ts"), zod: fileURLToPath(new URL("./node_modules/zod", import.meta.url)) } },
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
