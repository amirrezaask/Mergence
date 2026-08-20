import { defineConfig, lazyPlugins } from "vite-plus";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: lazyPlugins(() => [react(), tailwindcss()]),
  // Pierre @pierre/diffs worker is an ES module (code-splitting); iife fails the build.
  worker: {
    format: "es",
  },
  resolve: {
    alias: {
      "@yaade/ui/styles.css": path.resolve(__dirname, "../yaade-ui/src/styles/globals.css"),
      "@": path.resolve(__dirname, "../yaade-ui/src"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "git-diff",
              test: (id) => id.includes("@pierre/diffs") || id.includes("shiki"),
              includeDependenciesRecursively: false,
            },
          ],
        },
      },
    },
  },
});
