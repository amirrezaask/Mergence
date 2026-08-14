/**
 * Side-effect imports required when using `monaco-editor/esm/vs/editor/editor.api.js`.
 * Without these, the editor has no Monarch tokenizers (everything paints as mtk1)
 * and many editor contributions (find, folding, hover) stay unregistered.
 *
 * Note: do NOT import `language/typescript/monaco.contribution` here — that swaps
 * Monarch for the TS worker tokenizer. We use external LSP for semantics; Monarch
 * is enough for syntax colors and avoids worker-tokenization races.
 */
import "./monaco-css.js"
import "monaco-editor/esm/vs/editor/editor.all.js"
// `editor.all` registers the reference commands but not the standalone peek
// controller that renders their results.
import "monaco-editor/esm/vs/editor/standalone/browser/referenceSearch/standaloneReferenceSearch.js"
