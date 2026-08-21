import { fileURLToPath } from "node:url"

export function fixturePath(name: string): string {
  if (!/^[a-z0-9-]+\.mjs$/u.test(name)) {
    throw new Error(`invalid terminal fixture name: ${name}`)
  }
  return fileURLToPath(new URL(`../test-fixtures/${name}`, import.meta.url))
}

export function fixtureLaunch(
  name: string,
  args: readonly string[] = [],
): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [fixturePath(name), ...args],
  }
}
