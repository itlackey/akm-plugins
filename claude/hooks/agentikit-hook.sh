#!/usr/bin/env sh

set -eu

COMMAND="${1:-}"
MODE="${2:-}"
PACKAGE_REF="akm-cli@latest"
STATE_DIR="${AKM_PLUGIN_STATE_DIR:-${XDG_STATE_HOME:-${HOME:-.}/.local/state}/agentikit-claude}"
SESSION_LOG="$STATE_DIR/session.log"
FEEDBACK_LOG="$STATE_DIR/feedback.log"
MEMORY_LOG="$STATE_DIR/memory.log"

mkdir -p "$STATE_DIR"

timestamp() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

sanitize() {
  tr '\t\r\n' '   ' | sed 's/  */ /g; s/^ //; s/ $//'
}

first_line() {
  tr -d '\r' | head -n 1
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

find_writable_path_dir() {
  OLD_IFS="${IFS}"
  IFS=":"
  for dir in $PATH; do
    if [ -n "$dir" ] && [ -d "$dir" ] && [ -w "$dir" ]; then
      printf '%s\n' "$dir"
      IFS="${OLD_IFS}"
      return 0
    fi
  done
  IFS="${OLD_IFS}"
  return 1
}

ensure_on_path() {
  target="$1"
  [ -x "$target" ] || return 0

  current="$(command -v akm 2>/dev/null || true)"
  if [ "$current" = "$target" ]; then
    return 0
  fi

  writable_dir="$(find_writable_path_dir || true)"
  if [ -n "$writable_dir" ]; then
    ln -sf "$target" "$writable_dir/akm" 2>/dev/null || cp "$target" "$writable_dir/akm" 2>/dev/null || true
  fi
}

npm_global_bin() {
  npm bin -g 2>/dev/null || {
    prefix="$(npm prefix -g 2>/dev/null || true)"
    if [ -n "$prefix" ]; then
      printf '%s/bin\n' "$prefix"
    fi
  }
}

ensure_akm() {
  installer="path"
  installed_bin=""

  if command -v bun >/dev/null 2>&1; then
    installer="bun"
    global_bin="$(bun pm bin -g 2>/dev/null || true)"
    if bun install -g "$PACKAGE_REF" >/dev/null 2>&1 && [ -n "$global_bin" ]; then
      installed_bin="$global_bin/akm"
    fi
  fi

  if [ -z "$installed_bin" ] && command -v npm >/dev/null 2>&1; then
    installer="npm"
    if npm install -g "$PACKAGE_REF" >/dev/null 2>&1; then
      global_bin="$(npm_global_bin)"
      if [ -n "$global_bin" ]; then
        installed_bin="$global_bin/akm"
      fi
    fi
  fi

  if [ -n "$installed_bin" ]; then
    ensure_on_path "$installed_bin"
  fi

  resolved="$(command -v akm 2>/dev/null || true)"
  if [ -n "$resolved" ]; then
    version="$("$resolved" --version 2>/dev/null | first_line || true)"
    append_log "$SESSION_LOG" "akm_ready" "$installer" "$resolved" "${version:-unknown}"
  else
    append_log "$SESSION_LOG" "akm_missing" "$installer" "$PACKAGE_REF"
  fi
}

extract_user_text() {
  python3 -c '
import json
import sys

raw = sys.stdin.read()
if not raw.strip():
    print("")
    raise SystemExit(0)

try:
    data = json.loads(raw)
except Exception:
    print(" ".join(raw.split()))
    raise SystemExit(0)

def flatten(value):
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        for key in ("text", "prompt", "message", "input", "content", "value"):
            result = flatten(value.get(key))
            if result:
                return result
        return ""
    if isinstance(value, list):
        parts = [flatten(item) for item in value]
        return " ".join(part for part in parts if part)
    return ""

for candidate in (
    data.get("prompt"),
    data.get("message"),
    data.get("input"),
    data.get("userPrompt"),
    data.get("text"),
    data,
):
    result = flatten(candidate)
    if result:
        print(" ".join(result.split()))
        raise SystemExit(0)

print("")
'
}

extract_post_tool_fields() {
  python3 -c '
import json
import re
import sys

mode = sys.argv[1] or "success"
raw = sys.stdin.read()
if not raw.strip():
    print("")
    print("")
    print(mode)
    print("")
    raise SystemExit(0)

try:
    data = json.loads(raw)
except Exception:
    print("")
    print(" ".join(raw.split()))
    print(mode)
    print("")
    raise SystemExit(0)

def get_text(value):
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        for key in ("command", "output", "stderr", "stdout", "text", "value"):
            text = get_text(value.get(key))
            if text:
                return text
        return ""
    if isinstance(value, list):
        parts = [get_text(item) for item in value]
        return " ".join(part for part in parts if part)
    return ""

tool = ""
for key in ("tool", "tool_name", "toolName"):
    value = data.get(key)
    if isinstance(value, str) and value:
        tool = value
        break

command = get_text(data.get("input")) or get_text(data.get("tool_input")) or get_text(data.get("command")) or ""
output = get_text(data.get("output")) or get_text(data.get("tool_output")) or get_text(data.get("response")) or ""
combined = "\n".join(part for part in (command, output) if part)
refs = set(re.findall(r"memory:[A-Za-z0-9._/-]+", combined))

if not refs and "akm remember" in command:
    name_match = re.search(r"--name\s+([A-Za-z0-9._/-]+)", command)
    if name_match:
        refs.add(f"memory:{name_match.group(1)}")

print(tool)
print(" ".join(command.split()))
print(mode)
print(",".join(sorted(refs)))
' "$MODE"
}

record_user_feedback() {
  raw_input="$(cat)"
  text="$(printf '%s' "$raw_input" | extract_user_text | sanitize)"
  [ -n "$text" ] || exit 0

  append_log "$FEEDBACK_LOG" "user" "prompt" "$text"

  if printf '%s' "$text" | grep -Eiq '\b(remember|memory|memories)\b'; then
    append_log "$MEMORY_LOG" "user" "intent" "$text"
  fi
}

record_post_tool() {
  raw_input="$(cat)"
  fields="$(printf '%s' "$raw_input" | extract_post_tool_fields)"
  tool_name="$(printf '%s\n' "$fields" | sed -n '1p' | sanitize)"
  command_text="$(printf '%s\n' "$fields" | sed -n '2p' | sanitize)"
  status_text="$(printf '%s\n' "$fields" | sed -n '3p' | sanitize)"
  refs_csv="$(printf '%s\n' "$fields" | sed -n '4p' | sanitize)"

  case "$command_text" in
    *akm*|*/akm*)
      append_log "$FEEDBACK_LOG" "system" "$status_text" "${tool_name:-Bash}" "$command_text"
      ;;
  esac

  if [ -n "$refs_csv" ]; then
    OLD_IFS="${IFS}"
    IFS=","
    for ref in $refs_csv; do
      [ -n "$ref" ] || continue
      append_log "$MEMORY_LOG" "system" "${tool_name:-Bash}" "$ref" "$command_text"
    done
    IFS="${OLD_IFS}"
  fi
}

case "$COMMAND" in
  ensure-akm)
    ensure_akm
    ;;
  user-feedback)
    record_user_feedback
    ;;
  post-tool)
    record_post_tool
    ;;
  *)
    echo "Unknown command: $COMMAND" >&2
    exit 1
    ;;
esac
