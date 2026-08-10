import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import path from "node:path"

const appRoot = path.resolve(__dirname, "../../packages/yaade-app")
const uiRoot = path.resolve(__dirname, "../../packages/yaade-ui/src")

const browserTargets = ["chrome107", "edge107", "firefox104", "safari16"]

export default defineConfig({
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
            if (id.includes("@pierre/diffs")) return "diffs"
            if (id.includes("shiki") || id.includes("@shikijs")) return "shiki"
            if (id.includes("@xterm")) return "xterm"
          }
        },
      },
    },
  },
  plugins: [
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
})
