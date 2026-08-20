# Shared tsx resolution for the mock launchers. Sourced, not executed.
# Prefers the workspace-pinned tsx so mocks run on the same Node as the caller
# (avoids native-module ABI drift with a globally installed tsx).

exec_tsx() {
  local entry="$1"
  shift

  local repo_root
  repo_root="$(cd "$BIN_DIR/../../../.." && pwd)"

  local candidates=(
    "${YAADE_TSX_CLI:-}"
    "$repo_root/node_modules/tsx/dist/cli.mjs"
  )
  local pnpm_dir="$repo_root/node_modules/.pnpm"
  if [[ -d "$pnpm_dir" ]]; then
    local hoisted
    for hoisted in "$pnpm_dir"/tsx@*/node_modules/tsx/dist/cli.mjs; do
      candidates+=("$hoisted")
    done
  fi

  local candidate
  for candidate in "${candidates[@]}"; do
    if [[ -n "$candidate" && -f "$candidate" ]]; then
      exec node "$candidate" "$entry" "$@"
    fi
  done

  if command -v tsx >/dev/null 2>&1; then
    exec tsx "$entry" "$@"
  fi

  echo "tsx CLI missing; run pnpm install from the repo root" >&2
  exit 1
}
