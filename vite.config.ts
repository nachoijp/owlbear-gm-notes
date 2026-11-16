import { defineConfig, type Plugin } from "vite";
import { readFileSync, rmSync } from "node:fs";
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

// On the dev server, manifest.json says "(dev)" after the extension's name and its toolbar title, so
// a room with both installed can tell this one from the published one. The build is untouched.
function devManifestName(): Plugin {
  return {
    name: "dev-manifest-name",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || req.url.split("?")[0] !== "/manifest.json") return next();
        const manifest = JSON.parse(readFileSync(resolve(server.config.root, "public/manifest.json"), "utf8"));
        manifest.name += " (dev)";
        if (manifest.action) manifest.action.title += " (dev)";
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.end(JSON.stringify(manifest, null, 2));
      });
    },
  };
}

export default defineConfig({
  plugins: [dropLocalManifest(), devManifestName()],
  // Three pages: the panel, the background page (always loaded, so built apart and kept tiny) and a
  // note's quick view (peek.html, opened from a map badge).
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        background: resolve(import.meta.dirname, "background.html"),
        peek: resolve(import.meta.dirname, "peek.html"),
      },
    },
  },
  server: {
    cors: true,
  },
  preview: {
    cors: true,
  },
});
