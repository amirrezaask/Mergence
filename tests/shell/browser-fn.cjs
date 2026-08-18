/**
 * Transpile test page functions in Node — WKWebView CSP blocks eval and
 * WebDriver cannot run TypeScript syntax in execute scripts.
 */
const { createRequire } = require("node:module")

const requireFromHere = createRequire(__filename)
const esbuild = requireFromHere(
  requireFromHere.resolve("esbuild", {
    paths: [requireFromHere.resolve("@playwright/test/package.json")],
  }),
)

/** @param {string} source function.toString() body */
function browserFn(source) {
  const trimmed = source.trim()
  const wrapped =
    trimmed.startsWith("function") || trimmed.startsWith("async function")
      ? `(${source})`
      : trimmed.startsWith("(")
        ? source
        : `(${source})`
  const { code } = esbuild.transformSync(wrapped, { loader: "ts", target: "es2017" })
  return code.trim().replace(/;\s*$/, "")
}

/** @param {string | ((...args: unknown[]) => unknown)} script */
function serializeBrowserScript(script) {
  if (script instanceof Function) {
    return `return (${browserFn(script.toString())}).apply(null, arguments)`
  }
  return String(script)
}

module.exports = { browserFn, serializeBrowserScript }
