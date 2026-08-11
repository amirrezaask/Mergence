import { defineConfig, type Plugin } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import path from "node:path"
import { applyDevBuildBrandingToHtml } from "../../packages/yaade-app/src/build-branding-html.ts"

const appRoot = path.resolve(__dirname, "../../packages/yaade-app")
const uiRoot = path.resolve(__dirname, "../../packages/yaade-ui/src")

const browserTargets = ["chrome107", "edge107", "firefox104", "safari16"]

function yaadeBuildBranding(command: "build" | "serve"): Plugin {
  return {
    name: "yaade-build-branding",
    transformIndexHtml(html) {
      // `vite` / `vite --mode development` → badged favicon + DEV title seed.
      // Production `vite build` keeps the release icons in index.html as-is.
      if (command !== "serve") return html
      return applyDevBuildBrandingToHtml(html)
    },
  }
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
    rollupOptions: {
      input: {
        index: path.resolve(appRoot, "index.html"),
      },
      output: {
        onlyExplicitManualChunks: true,
        manualChunks(id) {
          const isPending =
            id.includes("pending-editor") || id.includes("/monaco/pending")
          const basicLanguage =
            /monaco-editor\/esm\/vs\/basic-languages\/([^/]+)\//.exec(id)?.[1]
          if (basicLanguage) return `monaco-lang-${basicLanguage}`
          const serviceLanguage =
            /monaco-editor\/esm\/vs\/language\/(css|html|json)\//.exec(id)?.[1]
          if (serviceLanguage) return `monaco-lang-${serviceLanguage}`
          if (
            !isPending &&
            (id.includes("monaco-editor") ||
              id.includes("yaade-monaco") ||
              id.includes("@yaade/monaco"))
          ) {
            return "monaco"
          }
          if (id.includes("node_modules")) {
          if (id.includes("@pierre/diffs") || id.includes("@pierre/trees")) return "diffs"
            const shikiLang = /@shikijs\/langs\/dist\/([^/.]+)/.exec(id)?.[1]
            if (shikiLang) return `shiki-lang-${shikiLang}`
            if (id.includes("shiki") || id.includes("@shikijs")) return "shiki"
            if (id.includes("@xterm")) return "xterm"
          }
        },
      },
    },
  },
  plugins: [
    yaadeBuildBranding(command),
    react({
      babel: {
        plugins: [["babel-plugin-react-compiler", {}]],
      },
    }),
    tailwindcss(),
  ],
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
    host: "127.0.0.1",
    allowedHosts: ["ide.local"],
    proxy: {
      "/api": `http://127.0.0.1:${process.env.JET_PORT ?? 4747}`,
      "/health": `http://127.0.0.1:${process.env.JET_PORT ?? 4747}`,
      "/ws": {
        target: `ws://127.0.0.1:${process.env.JET_PORT ?? 4747}`,
        ws: true,
      },
    },
  },
  clearScreen: false,
}))