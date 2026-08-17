import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export type NeovimEndpoint =
  | { readonly kind: "unix"; readonly path: string }
  | { readonly kind: "pipe"; readonly path: string }

const UNIX_SOCKET_PATH_LIMIT = 100

function shortHash(toolUseId: string, generation: number): string {
  return crypto
    .createHash("sha256")
    .update(`${toolUseId}:${generation}`)
    .digest("hex")
    .slice(0, 20)
}

function privateTempRoot(): string {
  const candidates = process.platform === "win32"
    ? [os.tmpdir()]
    : ["/tmp", os.tmpdir()]
  for (const parent of candidates) {
    try {
      const root = fs.mkdtempSync(path.join(parent, "yn-"))
      fs.chmodSync(root, 0o700)
      return root
    } catch {
      /* Try the next platform-appropriate temporary directory. */
    }
  }
  throw new Error("could not create a private Neovim endpoint directory")
}

export class NeovimEndpointStore {
  readonly root: string
  private readonly roots = new Set<string>()

  constructor() {
    this.root = privateTempRoot()
    this.roots.add(this.root)
  }

  endpoint(toolUseId: string, generation: number): NeovimEndpoint {
    const hash = shortHash(toolUseId, generation)
    if (process.platform === "win32") {
      return { kind: "pipe", path: `\\\\.\\pipe\\yaade-nvim-${hash}` }
    }
    let endpointPath = path.join(this.root, `n-${hash}.sock`)
    // Unix-domain socket paths are short on macOS and Linux. If a caller has a
    // deeply nested temporary directory, use a short private root instead of
    // silently handing a too-long path to Neovim.
    if (endpointPath.length > UNIX_SOCKET_PATH_LIMIT) {
      const shortRoot = fs.mkdtempSync(path.join("/tmp", "yn-"))
      fs.chmodSync(shortRoot, 0o700)
      this.roots.add(shortRoot)
      endpointPath = path.join(shortRoot, `n-${hash}.sock`)
    }
    if (endpointPath.length > UNIX_SOCKET_PATH_LIMIT) {
      throw new Error("could not create a short private Neovim socket path")
    }
    return { kind: "unix", path: endpointPath }
  }

  cleanup(endpoint: NeovimEndpoint): void {
    if (endpoint.kind === "pipe") return
    try {
      fs.unlinkSync(endpoint.path)
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        throw error
      }
    }
  }

  close(): void {
    for (const root of this.roots) {
      try {
        fs.rmSync(root, { recursive: true, force: true })
      } catch {
        /* Endpoint cleanup is best effort during process shutdown. */
      }
    }
    this.roots.clear()
  }
}
