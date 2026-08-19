export default {
  plugins: ["react", "unicorn", "typescript", "oxc"],
  ignorePatterns: [
    ".agent/**",
    ".agents/**",
    ".claude/**",
    ".codex/**",
    ".continue/**",
    ".cursor/**",
    ".gemini/**",
    ".opencode/**",
    ".pi/**",
    ".roo/**",
    ".windsurf/**",
    ".repos/**",
    "tools/oxlint/anti-slop/**",
  ],
  jsPlugins: [
    { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
  ],
  rules: {
    // Keep dead code and common React identity traps from accumulating. React
    // Compiler handles broad memoization; deliberately avoid noisy
    // react-perf/no-new-*-as-prop rules that fight the compiler.
    "eslint/no-unused-vars": "error",
    "react/jsx-no-constructed-context-values": "error",
    "react/no-object-type-as-default-prop": "error",
    // Render callbacks receive row data by design; still reject component
    // definitions created during render.
    "react/no-unstable-nested-components": [
      "error",
      { allowAsProps: true },
    ],
    "react/exhaustive-deps": "error",
    "unicorn/prefer-set-has": "error",
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-runtime-typeof": "error",
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",
  },
}
