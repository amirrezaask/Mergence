/**
 * Legacy mux keymap — re-exports the catalog.
 *
 * Compat-only. Edit bindings in `packages/yaade-app/src/keybindings.ts`.
 * Do not add rows.
 */

export {
  MUX_DIRECT_BINDINGS,
  MUX_PREFIX,
  MUX_PREFIX_BINDINGS,
  MUX_UNZOOM_BINDING,
  isMuxPaletteHardwire,
  muxPrefixBindingKey,
  prefixLiteralByte,
  type MuxDirectBinding,
  type MuxPrefixBinding,
} from "../keybindings.js"
