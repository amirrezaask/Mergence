import { defineConfig, type Plugin, lazyPlugins } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { applyDevBuildBrandingToHtml } from "../../packages/yaade-app/src/build-branding-html.js";

const appRoot = path.resolve(__dirname, "../../packages/yaade-app");
const uiRoot = path.resolve(__dirname, "../../packages/yaade-ui/src");

const browserTargets = ["chrome107", "edge107", "firefox104", "safari16"];
const viteHost = process.env.JET_WEB_HOST ?? process.env.JET_HOST ?? "127.0.0.1";
const rawProxyHost =
  process.env.JET_PROXY_HOST ??
  (viteHost === "0.0.0.0" || viteHost === "::" ? "127.0.0.1" : viteHost);
const proxyHost =
  rawProxyHost.includes(":") && !rawProxyHost.startsWith("[") ? `[${rawProxyHost}]` : rawProxyHost;
const configuredAllowedHosts = (process.env.JET_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);
const isLoopbackHost = (host: string): boolean =>
  ["localhost", "127.0.0.1", "::1"].includes(
    host
      .trim()
      .toLowerCase()
      .replace(/^\[|\]$/g, ""),
  );
const allowedHosts =
  configuredAllowedHosts.length > 0
    ? configuredAllowedHosts
    : isLoopbackHost(viteHost)
      ? ["ide.local"]
      : true;

function yaadeBuildBranding(command: "build" | "serve"): Plugin {
  return {
    name: "yaade-build-branding",
    transformIndexHtml(html) {
      // `vite` / `vite --mode development` → badged favicon + DEV title seed.
      // Production `vite build` keeps the release icons in index.html as-is.
      if (command !== "serve") return html;
      return applyDevBuildBrandingToHtml(html);
    },
  };
}

export default defineConfig(({ command }) => ({
  base: "/",
  // Pierre @pierre/diffs worker is an ES module (code-splitting); iife fails the build.
  worker: {
    format: "es",
  },
  build: {
    target: browserTargets,
    cssTarget: browserTargets,
    outDir: path.resolve(__dirname, "dist"),
    emptyOutDir: true,
    rolldownOptions: {
      input: { index: path.resolve(appRoot, "index.html") },
      output: {
        codeSplitting: {
          groups: [
            {
              name: "diffs",
              test: (id) =>
                id.includes("node_modules") &&
                (id.includes("@pierre/diffs") || id.includes("@pierre/trees")),
              includeDependenciesRecursively: false,
            },
            {
              name: (id) => {
                const shikiLang = /@shikijs\/langs\/dist\/([^/.]+)/.exec(id)?.[1];
                if (shikiLang) return `shiki-lang-${shikiLang}`;
                if (id.includes("shiki") || id.includes("@shikijs")) return "shiki";
                return null;
              },
              test: (id) =>
                id.includes("node_modules") && (id.includes("shiki") || id.includes("@shikijs")),
              includeDependenciesRecursively: false,
            },
          ],
        },
      },
    },
  },
  plugins: lazyPlugins(() => [
    yaadeBuildBranding(command),
    // The app still contains imperative integrations and third-party hooks that
    // are not safe for infer-mode compilation. Adopt the compiler explicitly
    // with "use memo" once a component has been audited.
    react({ compiler: { compilationMode: "annotation" } }),
    tailwindcss(),
  ]),
  root: appRoot,
  resolve: {
    alias: {
      "@yaade/ui/styles.css": path.resolve(uiRoot, "styles/globals.css"),
      "@": uiRoot,
    },
  },
  server: {
    port: Number(process.env.JET_WEB_PORT ?? 5174),
    // Prefer the configured port; if busy, Vite picks the next free one.
    strictPort: false,
    host: viteHost,
    allowedHosts,
    proxy: {
      "/api": `http://${proxyHost}:${process.env.JET_PORT ?? 4747}`,
      "/health": `http://${proxyHost}:${process.env.JET_PORT ?? 4747}`,
      "/ws": {
        target: `ws://${proxyHost}:${process.env.JET_PORT ?? 4747}`,
        ws: true,
      },
    },
  },
  clearScreen: false,
}));
