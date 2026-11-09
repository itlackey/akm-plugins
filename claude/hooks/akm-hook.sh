#!/usr/bin/env sh

ROOT_DIR="$(dirname "$0")"
# Claude Code unless the hook command says --harness=codex, as the Codex manifest's does. A Codex
# run keeps its state in PLUGIN_DATA, the plugin data directory Codex exports to its hooks.
host=Claude
for arg in "$@"; do
  [ "$arg" = "--harness=codex" ] && host=Codex
done
if [ "$host" = "Codex" ] && [ -n "${PLUGIN_DATA:-}" ]; then
  STATE_DIR="$PLUGIN_DATA"
else
  STATE_DIR="${XDG_STATE_HOME:-${HOME:-.}/.local/state}/akm-claude"
fi
SESSION_LOG="$STATE_DIR/session.log"
mkdir -p "$STATE_DIR" 2>/dev/null || true

timestamp() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

append_log() {
  file="$1"
  shift
  printf '%s' "$(timestamp)" >> "$file"
  for field in "$@"; do
    printf '\t%s' "$field" >> "$file"
  done
  printf '\n' >> "$file"
}

if ! command -v bun >/dev/null 2>&1; then
  # Name the host that is actually running the wrapper: "Claude hooks are
  # disabled" is wrong advice in a Codex session.
  append_log "$SESSION_LOG" "runtime_disabled" "bun_unavailable" "$host AKM hooks are disabled until Bun is installed and on PATH."
  case "$1" in
    session-start)
      printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"AKM %s hooks are currently disabled because the Bun runtime is not available on PATH. Install Bun from https://bun.sh to re-enable AKM hook automation and logging."},"systemMessage":"AKM %s hooks are disabled: the Bun runtime is not on PATH. Install it from https://bun.sh to re-enable them."}' "$host" "$host"
      ;;
  esac
  exit 0
fi

exec bun "$ROOT_DIR/akm-hook.ts" "$@"
