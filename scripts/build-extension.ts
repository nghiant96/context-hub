import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Build the Claude Desktop extension: one bundled file (no node_modules to
// ship), the manifest at the package version, packed as dist/context-hub-<version>.mcpb.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "dist", "extension");
const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version: string };

fs.rmSync(out, { recursive: true, force: true });
await build({
  entryPoints: [path.join(root, "src", "extension-main.ts")],
  outfile: path.join(out, "server", "index.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // Bundled CommonJS dependencies still call require() for Node built-ins.
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  legalComments: "none",
  logLevel: "warning"
});

const manifest = JSON.parse(fs.readFileSync(path.join(root, "extension", "manifest.json"), "utf8")) as { version: string };
manifest.version = version;
fs.writeFileSync(path.join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const mcpb = path.join(root, "node_modules", ".bin", "mcpb");
const bundle = path.join(root, "dist", `context-hub-${version}.mcpb`);
execFileSync(mcpb, ["validate", path.join(out, "manifest.json")], { stdio: "inherit", shell: process.platform === "win32" });
execFileSync(mcpb, ["pack", out, bundle], { stdio: "inherit", shell: process.platform === "win32" });
console.log(`✓ ${path.relative(root, bundle)}`);
