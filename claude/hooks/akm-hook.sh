#!/usr/bin/env sh

ROOT_DIR="$(dirname "$0")"
STATE_DIR="${AKM_PLUGIN_STATE_DIR:-${XDG_STATE_HOME:-${HOME:-.}/.local/state}/akm-claude}"
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
  append_log "$SESSION_LOG" "runtime_disabled" "bun_unavailable" "Claude AKM hooks are disabled until Bun is installed and on PATH."
  case "$1" in
    session-start)
      printf '%s' '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"AKM Claude hooks are currently disabled because the Bun runtime is not available on PATH. Install Bun to re-enable AKM hook automation and logging."}}'
      ;;
  esac
  exit 0
fi

exec bun "$ROOT_DIR/akm-hook.ts" "$@"
