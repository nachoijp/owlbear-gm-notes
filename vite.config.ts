import { defineConfig, type Plugin } from "vite";
import { rmSync } from "node:fs";
import { resolve } from "node:path";

// public/manifest-local.json points Owlbear at the local dev server (localhost:5173). The dev server
// needs it in public/, but it has no use in production, so it's dropped from the build output — the
// whole dist/ folder can be uploaded as-is.
function dropLocalManifest(): Plugin {
  let outDir = "dist";
  return {
    name: "drop-local-manifest",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      rmSync(resolve(outDir, "manifest-local.json"), { force: true });
    },
  };
}

export default defineConfig({
  plugins: [dropLocalManifest()],
  server: {
    cors: true,
  },
  preview: {
    cors: true,
  },
});
