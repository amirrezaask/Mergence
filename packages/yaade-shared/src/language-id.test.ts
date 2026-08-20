import { describe, it } from "vite-plus/test"
import assert from "node:assert/strict"
import { languageIdFromPath } from "./index.js"

describe("languageIdFromPath", () => {
  it("maps popular source extensions", () => {
    assert.equal(languageIdFromPath("src/main.py"), "python")
    assert.equal(languageIdFromPath("pkg/types.pyi"), "python")
    assert.equal(languageIdFromPath("app.rb"), "ruby")
    assert.equal(languageIdFromPath("lib/task.rake"), "ruby")
    assert.equal(languageIdFromPath("src/lib.rs"), "rust")
    assert.equal(languageIdFromPath("cmd/main.go"), "go")
    assert.equal(languageIdFromPath("config.yaml"), "yaml")
    assert.equal(languageIdFromPath("config.yml"), "yaml")
    assert.equal(languageIdFromPath("scripts/run.sh"), "shell")
    assert.equal(languageIdFromPath("Cargo.toml"), "toml")
    assert.equal(languageIdFromPath("styles.scss"), "scss")
    assert.equal(languageIdFromPath("query.graphql"), "graphql")
    assert.equal(languageIdFromPath("tsconfig.jsonc"), "jsonc")
  })

  it("maps basename specials without extensions", () => {
    assert.equal(languageIdFromPath("Dockerfile"), "dockerfile")
    assert.equal(languageIdFromPath("path/to/Makefile"), "shell")
    assert.equal(languageIdFromPath("Gemfile"), "ruby")
    assert.equal(languageIdFromPath("Rakefile"), "ruby")
  })

  it("keeps existing TS/JS/HTML mappings", () => {
    assert.equal(languageIdFromPath("src/index.ts"), "typescript")
    assert.equal(languageIdFromPath("App.tsx"), "tsx")
    assert.equal(languageIdFromPath("index.js"), "javascript")
    assert.equal(languageIdFromPath("page.html"), "html")
  })

  it("falls back to plaintext for unknown extensions", () => {
    assert.equal(languageIdFromPath("notes.xyz"), "plaintext")
    assert.equal(languageIdFromPath("README"), "plaintext")
  })
})
