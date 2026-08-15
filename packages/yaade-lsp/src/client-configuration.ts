import type { ConfigurationParams } from "vscode-languageserver-protocol"

/**
 * Yaade does not expose per-server settings yet. Returning one empty
 * settings object per requested section is still required: gopls treats a
 * missing `workspace/configuration` response as a workspace-load failure.
 */
export function defaultWorkspaceConfiguration(params: ConfigurationParams): object[] {
  return params.items.map(() => ({}))
}

function sectionValue(settings: unknown, section: string | undefined): unknown {
  if (!section) return settings ?? {}
  let current = settings
  for (const segment of section.split(".")) {
    if (!current || typeof current !== "object" || !(segment in current)) return {}
    current = Object.entries(current).find(([name]) => name === segment)?.[1]
  }
  return current ?? {}
}

/** Resolve `workspace/configuration` from the effective host-owned server settings. */
export function workspaceConfiguration(
  params: ConfigurationParams,
  settings: unknown,
): unknown[] {
  return params.items.map(item => sectionValue(settings, item.section))
}
