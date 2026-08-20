import path from "node:path"
import fs from "node:fs/promises"
import { pathToFileURL } from "node:url"

export type JetGlobalConfigContext = {
  projects: {
    setScanRoots(roots: string[]): void
  }
  showMessage(message: string): void
}

function createConfigContext(collected: string[]): JetGlobalConfigContext {
  return {
    projects: {
      setScanRoots(roots: string[]) {
        collected.push(...roots)
      },
    },
    showMessage() {},
  }
}

async function loadJetrcJson(jetDir: string): Promise<string[] | null> {
  try {
    const text = await fs.readFile(path.join(jetDir, "yaaderc.json"), "utf8")
    const data = JSON.parse(text) as { scanRoots?: unknown }
    if (Array.isArray(data.scanRoots) && data.scanRoots.every(v => typeof v === "string")) {
      return data.scanRoots
    }
  } catch {
    /* missing or invalid */
  }
  return null
}

async function loadJetrcTs(jetDir: string): Promise<string[]> {
  const tsPath = path.join(jetDir, "jetrc.ts")
  const collected: string[] = []
  try {
    await fs.access(tsPath)
    // Node 22.18+ strips TypeScript types natively; no second transpiler is
    // needed for the small user configuration module.
    const mod = (await import(pathToFileURL(tsPath).href)) as {
      default?: (ctx: JetGlobalConfigContext) => void | Promise<void>
      setup?: (ctx: JetGlobalConfigContext) => void | Promise<void>
    }
    const setup = mod.default ?? mod.setup
    if (typeof setup === "function") {
      await setup(createConfigContext(collected))
    }
  } catch {
    /* missing or invalid */
  }
  return collected
}

/** Load project scan roots from `~/.yaade/yaaderc.json` or `~/.yaade/jetrc.ts`. */
export async function loadGlobalYaadercScanRoots(homeDir: string): Promise<string[]> {
  const jetDir = path.join(homeDir, ".yaade")
  const fromJson = await loadJetrcJson(jetDir)
  if (fromJson) return fromJson
  return loadJetrcTs(jetDir)
}
