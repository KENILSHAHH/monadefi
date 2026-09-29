// Bundle the commands with the workspace libraries (@app/perpl, @app/risk) and their dependencies (viem, zod),
// so the packed tarball installs with `mm plugins install` and needs no monorepo and no runtime dependencies.
// @metamask/agent-wallet stays external: the host links its own copy so PluginCommand is the same class.
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

const root = fileURLToPath(new URL(".", import.meta.url));
const lib = (p: string) => join(root, "..", p);

function commandEntries(dir: string, out: Record<string, string> = {}): Record<string, string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) commandEntries(full, out);
    else if (name.endsWith(".ts")) out[relative(join(root, "src"), full).replace(/\.ts$/, "")] = full;
  }
  return out;
}

export default defineConfig({
  entry: commandEntries(join(root, "src", "commands")),
  outDir: "dist",
  format: ["esm"],
  platform: "node",
  target: "node22",
  splitting: true,
  bundle: true,
  clean: true,
  sourcemap: false,
  dts: false,
  treeshake: true,
  // Bundle everything except the host SDK (a negative lookahead: tsup gives noExternal priority over external).
  noExternal: [/^(?!@metamask\/agent-wallet)/],
  external: ["@metamask/agent-wallet", "@metamask/agent-wallet/plugin"],
  // Shared code goes to dist/chunks so oclif (which loads dist/commands/**) never sees it as a command.
  esbuildOptions(o) {
    o.chunkNames = "chunks/[name]-[hash]";
    o.alias = { "@app/perpl": lib("perpl/src/index.ts"), "@app/risk": lib("risk/src/index.ts") };
    // Workspace libraries resolve viem / zod from this package when their own node_modules is missing.
    o.nodePaths = [join(root, "node_modules")];
  },
});
