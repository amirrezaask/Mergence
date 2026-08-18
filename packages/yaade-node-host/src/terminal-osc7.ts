import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const INTEGRATION_VERSION = "2"

/**
 * OSC 7 — `ESC ] 7 ; file://[host]/path BEL` (or ST).
 * Shells emit this on cwd change when shell integration is active.
 */
const OSC7_RE = /\x1b\]7;([^\x07\x1b]*)(?:\x07|\x1b\\)/g

/** Parse the last OSC 7 path from a PTY chunk. Returns an absolute fs path or null. */
export function parseOsc7Cwd(chunk: string): string | null {
  let last: string | null = null
  OSC7_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = OSC7_RE.exec(chunk)) !== null) {
    const raw = match[1] ?? ""
    const parsed = fileUrlToPath(raw)
    if (parsed) last = parsed
  }
  return last
}

function fileUrlToPath(payload: string): string | null {
  const trimmed = payload.trim()
  if (!trimmed.startsWith("file://")) return null
  try {
    // file://hostname/path or file:///path or file://path
    const withoutScheme = trimmed.slice("file://".length)
    let pathname: string
    if (withoutScheme.startsWith("/")) {
      pathname = withoutScheme
    } else {
      const slash = withoutScheme.indexOf("/")
      if (slash < 0) return null
      pathname = withoutScheme.slice(slash)
    }
    const decoded = decodeURIComponent(pathname)
    return decoded.length > 0 ? decoded : null
  } catch {
    return null
  }
}

function integrationRoot(): string {
  return path.join(os.homedir(), ".local", "share", "yaade", "shell")
}

const ZSHRC = `# yaade-shell-integration ${INTEGRATION_VERSION}
# Report cwd via OSC 7 so mux neovim/git splits follow \`cd\`.
_yaade_user_zdotdir="\${YAADE_USER_ZDOTDIR:-$HOME}"
[[ -o login && -f "$_yaade_user_zdotdir/.zprofile" ]] && source "$_yaade_user_zdotdir/.zprofile"
[[ -f "$_yaade_user_zdotdir/.zshrc" ]] && source "$_yaade_user_zdotdir/.zshrc"
[[ -o login && -f "$_yaade_user_zdotdir/.zlogin" ]] && source "$_yaade_user_zdotdir/.zlogin"

_yaade_osc7() {
  builtin printf '\\033]7;file://%s%s\\033\\\\' "$HOST" "$PWD"
}
if [[ -z "$YAADE_OSC7_HOOKED" ]]; then
  YAADE_OSC7_HOOKED=1
  autoload -Uz add-zsh-hook 2>/dev/null
  if typeset -f add-zsh-hook >/dev/null 2>&1; then
    add-zsh-hook chpwd _yaade_osc7
    add-zsh-hook precmd _yaade_osc7
  fi
  _yaade_osc7
fi
`

const ZSHENV = `# yaade-shell-integration ${INTEGRATION_VERSION}
_yaade_user_zdotdir="\${YAADE_USER_ZDOTDIR:-$HOME}"
[[ -f "$_yaade_user_zdotdir/.zshenv" ]] && source "$_yaade_user_zdotdir/.zshenv"
`

const BASHRC = `# yaade-shell-integration ${INTEGRATION_VERSION}
if [[ -f "\${YAADE_USER_BASHRC:-$HOME/.bashrc}" ]]; then
  source "\${YAADE_USER_BASHRC:-$HOME/.bashrc}"
fi
_yaade_osc7() {
  printf '\\033]7;file://%s%s\\033\\\\' "\${HOSTNAME:-}" "$PWD"
}
if [[ -z "\${YAADE_OSC7_HOOKED:-}" ]]; then
  YAADE_OSC7_HOOKED=1
  PROMPT_COMMAND="_yaade_osc7\${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
  _yaade_osc7
fi
`

const FISH_INIT_COMMAND = `function _yaade_osc7 --on-event fish_prompt
  printf '\\033]7;file://%s\\033\\\\' "$PWD"
end`

/** Ensure shell integration files exist (idempotent). */
export function ensureShellIntegrationFiles(): string {
  const root = integrationRoot()
  fs.mkdirSync(root, { recursive: true })
  const stamp = path.join(root, `.version`)
  const write = (name: string, body: string) => {
    const target = path.join(root, name)
    try {
      if (fs.readFileSync(target, "utf8") === body) return
    } catch {
      /* missing */
    }
    fs.writeFileSync(target, body, "utf8")
  }
  let need = true
  try {
    need = fs.readFileSync(stamp, "utf8").trim() !== INTEGRATION_VERSION
  } catch {
    need = true
  }
  if (need) {
    write(".zshrc", ZSHRC)
    write(".zshenv", ZSHENV)
    write(".bashrc", BASHRC)
    fs.writeFileSync(stamp, INTEGRATION_VERSION, "utf8")
  }
  return root
}

/**
 * Wrap a default-shell spawn so interactive zsh/bash/fish emit OSC 7 at
 * command prompts. Custom launch commands (nvim, agents) are left unchanged.
 */
export function applyShellCwdReporting(
  command: string,
  args: string[],
  env: Record<string, string>,
): { command: string; args: string[]; env: Record<string, string> } {
  const base = path.basename(command)
  if (base === "fish") {
    return {
      command,
      args: ["--init-command", FISH_INIT_COMMAND, ...args],
      env,
    }
  }
  if (base !== "zsh" && base !== "bash") {
    return { command, args, env }
  }
  const root = ensureShellIntegrationFiles()
  if (base === "zsh") {
    const userZdot =
      typeof env.ZDOTDIR === "string" && env.ZDOTDIR.length > 0
        ? env.ZDOTDIR
        : process.env.ZDOTDIR && process.env.ZDOTDIR.length > 0
          ? process.env.ZDOTDIR
          : os.homedir()
    return {
      command,
      args: args.length > 0 ? args : ["-il"],
      env: {
        ...env,
        ZDOTDIR: root,
        YAADE_USER_ZDOTDIR: userZdot,
      },
    }
  }
  // bash
  const userBashrc =
    typeof env.YAADE_USER_BASHRC === "string" && env.YAADE_USER_BASHRC.length > 0
      ? env.YAADE_USER_BASHRC
      : path.join(os.homedir(), ".bashrc")
  return {
    command,
    args:
      args.length > 0
        ? args
        : ["--login", "-i", "--rcfile", path.join(root, ".bashrc")],
    env: {
      ...env,
      YAADE_USER_BASHRC: userBashrc,
    },
  }
}
