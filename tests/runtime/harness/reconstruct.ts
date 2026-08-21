import { BasicTerminalStateRecorder } from "../../../packages/yaade-node-host/src/terminal-state/recorder.js"
import type { AttachSnapshot } from "./rpc.js"

/** Apply checkpoint ANSI then deltas through a VT recorder. String-concat hides split tokens. */
export function reconstructAttachScreen(attached: AttachSnapshot): string {
  const cols = attached.checkpoint?.cols ?? attached.cols ?? 80
  const rows = attached.checkpoint?.rows ?? attached.rows ?? 24
  const recorder = new BasicTerminalStateRecorder(
    cols,
    rows,
    attached.terminalEpoch ?? "e2e",
  )
  if (attached.checkpoint?.syntheticAnsi) {
    recorder.write(attached.checkpoint.syntheticAnsi)
  }
  recorder.write((attached.outputChunks ?? []).join(""))
  return recorder.plainText()
}
