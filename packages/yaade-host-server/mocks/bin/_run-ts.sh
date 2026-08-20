# Shared Vite+ module-runner launcher for the mock scripts.
# Sourced, not executed.

exec_run_ts() {
  local entry="$1"
  shift

  local repo_root
  repo_root="$(cd "$BIN_DIR/../../../.." && pwd)"
  exec node "$repo_root/scripts/run-ts.mjs" "$entry" "$@"
}
