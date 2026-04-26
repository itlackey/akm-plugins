#!/usr/bin/env sh

set -eu

COMMAND="${1:-}"
MODE="${2:-}"
PACKAGE_REF="akm-cli@latest"
STATE_DIR="${AKM_PLUGIN_STATE_DIR:-${XDG_STATE_HOME:-${HOME:-.}/.local/state}/akm-claude}"
SESSIONS_DIR="$STATE_DIR/sessions"
SESSION_LOG="$STATE_DIR/session.log"
FEEDBACK_LOG="$STATE_DIR/feedback.log"
MEMORY_LOG="$STATE_DIR/memory.log"
CURATE_LIMIT="${AKM_CURATE_LIMIT:-5}"
CURATE_MIN_CHARS="${AKM_CURATE_MIN_CHARS:-16}"
CURATE_TIMEOUT="${AKM_CURATE_TIMEOUT:-8}"
CONTEXT_BUDGET_CHARS="${AKM_CONTEXT_BUDGET_CHARS:-4000}"
AUTO_FEEDBACK="${AKM_AUTO_FEEDBACK:-1}"
AUTO_MEMORY="${AKM_AUTO_MEMORY:-1}"
CURATED_PROMPT_HEADER="# AKM stash — assets relevant to this prompt"
CURATED_SESSION_HEADER="# AKM stash — assets relevant to this session"
CURATED_CONTEXT_TAIL="Tip: call \`akm show <ref>\` to fetch full content, and record \`akm feedback <ref> --positive|--negative\` once you know whether the asset helped."
SESSION_START_FOOTER="For verbs not covered by a slash command (save, import, clone, update, remove, list-sources, registry-search, reindex, config, upgrade, run-script, vault writes, …), run \`/akm-help\` first to discover the right \`akm\` CLI invocation, then run it via Bash."
SESSION_START_HEADER="$(cat <<'EOF'
# AKM is available in this session

You have an AKM stash on this machine. Before writing anything from scratch, call `akm curate "<task>"` or `akm search` to see if the stash already covers it. Record `akm feedback <ref> --positive|--negative` whenever an asset materially helps or misses, and use `akm remember` to persist durable learnings so future sessions inherit them.
EOF
)"

mkdir -p "$STATE_DIR" "$SESSIONS_DIR"

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

akm_available() {
  command -v akm >/dev/null 2>&1
}

# Run akm with a wall-clock timeout. Uses timeout(1) when available, otherwise
# falls back to running without a timeout. Always exits 0 so hooks never block
# the model — callers should check the captured stdout instead.
akm_run() {
  if command -v timeout >/dev/null 2>&1; then
    timeout --preserve-status "$CURATE_TIMEOUT" akm "$@" 2>/dev/null || true
  else
    akm "$@" 2>/dev/null || true
  fi
}

build_run_scope_args() {
  sid="$1"
  if [ -n "$sid" ]; then
    printf '%s\n' "--run" "$sid"
  fi
}

emit_hook_context() {
  event_name="$1"
  body="$2"
  HOOK_EVENT_NAME="$event_name" AKM_HOOK_CONTEXT="$body" AKM_CONTEXT_BUDGET="$CONTEXT_BUDGET_CHARS" python3 -c '
import json, os, sys
body = os.environ.get("AKM_HOOK_CONTEXT", "").strip()
if not body:
    sys.exit(0)
event_name = os.environ.get("HOOK_EVENT_NAME", "")
budget_raw = os.environ.get("AKM_CONTEXT_BUDGET", "1")
try:
    budget = max(1, int(budget_raw))
except Exception:
    budget = 4000
marker = "\n\n[truncated for context]"
if len(body) > budget:
    if budget <= len(marker):
        body = body[:budget]
    else:
        body = body[: budget - len(marker)] + marker
print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": event_name,
        "additionalContext": body,
    }
}))
'
}

extract_session_id() {
  python3 -c '
import json, sys
raw = sys.stdin.read()
if not raw.strip():
    print("")
    raise SystemExit(0)
try:
    data = json.loads(raw)
except Exception:
    print("")
    raise SystemExit(0)
sid = data.get("session_id") or data.get("sessionId") or data.get("session") or ""
if not isinstance(sid, str):
    sid = ""
# strip anything that would make a bad filename
print("".join(c for c in sid if c.isalnum() or c in "._-"))
'
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
    print("")
    raise SystemExit(0)

try:
    data = json.loads(raw)
except Exception:
    print("")
    print(" ".join(raw.split()))
    print(mode)
    print("")
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

# Detect any asset ref that akm might know about. Ref grammar from the skill:
#   [origin//]type:name   where type ∈ {skill, command, agent, knowledge, memory,
#                                       script, workflow, vault, wiki}
ref_pattern = re.compile(r"(?:[A-Za-z0-9@._+/-]+//)?(?:skill|command|agent|knowledge|memory|script|workflow|vault|wiki):[A-Za-z0-9._/-]+")
refs = set(ref_pattern.findall(combined))

if not refs and "akm remember" in command:
    name_match = re.search(r"--name\s+([A-Za-z0-9._/-]+)", command)
    if name_match:
        refs.add(f"memory:{name_match.group(1)}")

sid = data.get("session_id") or data.get("sessionId") or ""
if not isinstance(sid, str):
    sid = ""
sid = "".join(c for c in sid if c.isalnum() or c in "._-")

print(tool)
print(" ".join(command.split()))
print(mode)
print(",".join(sorted(refs)))
print(sid)
' "$MODE"
}

record_user_feedback() {
  raw_input="$(cat)"
  text="$(printf '%s' "$raw_input" | extract_user_text | sanitize)"
  sid="$(printf '%s' "$raw_input" | extract_session_id)"
  [ -n "$text" ] || exit 0

  append_log "$FEEDBACK_LOG" "user" "prompt" "$text"

  if printf '%s' "$text" | grep -Eiq '\b(remember|memory|memories)\b'; then
    append_log "$MEMORY_LOG" "user" "intent" "$text"
    if [ -n "$sid" ]; then
      buffer="$SESSIONS_DIR/$sid.md"
      printf '## %s — user memory intent\n%s\n\n' "$(timestamp)" "$text" >> "$buffer"
    fi
  fi
}

record_post_tool() {
  raw_input="$(cat)"
  fields="$(printf '%s' "$raw_input" | extract_post_tool_fields)"
  tool_name="$(printf '%s\n' "$fields" | sed -n '1p' | sanitize)"
  command_text="$(printf '%s\n' "$fields" | sed -n '2p' | sanitize)"
  status_text="$(printf '%s\n' "$fields" | sed -n '3p' | sanitize)"
  refs_csv="$(printf '%s\n' "$fields" | sed -n '4p' | sanitize)"
  sid="$(printf '%s\n' "$fields" | sed -n '5p' | sanitize)"

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
      if [ -n "$sid" ]; then
        buffer="$SESSIONS_DIR/$sid.md"
        printf '## %s — %s %s\n- ref: %s\n- command: %s\n\n' \
          "$(timestamp)" "${tool_name:-Bash}" "$status_text" "$ref" "$command_text" >> "$buffer"
      fi
    done
    IFS="${OLD_IFS}"
  fi
}

# Auto-feedback: when the model uses a stash asset via a real akm command and
# it succeeds or fails, record feedback on that ref so the stash ranks it
# better (or worse) next time. This runs in addition to record_post_tool.
auto_feedback() {
  [ "$AUTO_FEEDBACK" = "1" ] || exit 0
  akm_available || exit 0

  raw_input="$(cat)"
  fields="$(printf '%s' "$raw_input" | extract_post_tool_fields)"
  command_text="$(printf '%s\n' "$fields" | sed -n '2p' | sanitize)"
  status_text="$(printf '%s\n' "$fields" | sed -n '3p' | sanitize)"
  refs_csv="$(printf '%s\n' "$fields" | sed -n '4p' | sanitize)"

  # Only react when the command actually invoked akm — otherwise refs in a
  # generic tool output are likely discussion, not usage.
  case "$command_text" in
    *akm*|*/akm*) ;;
    *) exit 0 ;;
  esac

  # Don't recurse: skip if the command *is* an akm feedback call already.
  case "$command_text" in
    *akm[[:space:]]feedback*|*/akm[[:space:]]feedback*) exit 0 ;;
  esac

  [ -n "$refs_csv" ] || exit 0

  sentiment_flag="--positive"
  note="claude-code auto: tool succeeded"
  if [ "$status_text" = "failure" ]; then
    sentiment_flag="--negative"
    note="claude-code auto: tool failed"
  fi

  OLD_IFS="${IFS}"
  IFS=","
  for ref in $refs_csv; do
    [ -n "$ref" ] || continue
    case "$ref" in
      memory:*) continue ;;  # memories don't take feedback today
      vault:*) continue ;;   # vault values never surface — feedback is noise
    esac
    akm_run --format json -q feedback "$ref" "$sentiment_flag" --note "$note" >/dev/null
  done
  IFS="${OLD_IFS}"
}

# Build an additionalContext payload from akm curate + hints for a user prompt.
# Emits JSON to stdout so Claude Code injects it into the next turn.
curate_prompt() {
  # Keep the default feedback recording alongside curation so session logs
  # stay populated even when curation bails early.
  raw_input="$(cat)"
  text="$(printf '%s' "$raw_input" | extract_user_text | sanitize)"
  sid="$(printf '%s' "$raw_input" | extract_session_id)"

  # Fall back to the existing recorder so nothing regresses.
  if [ -n "$text" ]; then
    append_log "$FEEDBACK_LOG" "user" "prompt" "$text"
    if printf '%s' "$text" | grep -Eiq '\b(remember|memory|memories)\b'; then
      append_log "$MEMORY_LOG" "user" "intent" "$text"
      if [ -n "$sid" ]; then
        printf '## %s — user memory intent\n%s\n\n' "$(timestamp)" "$text" \
          >> "$SESSIONS_DIR/$sid.md"
      fi
    fi
  fi

  # Short prompts rarely yield useful curation — skip to keep signal high.
  prompt_len=$(printf '%s' "$text" | wc -c | tr -d ' ')
  if [ -z "$text" ] || [ "${prompt_len:-0}" -lt "$CURATE_MIN_CHARS" ]; then
    exit 0
  fi

  akm_available || exit 0

  curated="$(akm_run --for-agent --format text --detail summary -q curate "$text" --limit "$CURATE_LIMIT" $(build_run_scope_args "$sid"))"
  [ -n "$(printf '%s' "$curated" | tr -d ' \t\n\r')" ] || exit 0

  # Emit Claude Code's hookSpecificOutput JSON to inject context into the turn.
  emit_hook_context "UserPromptSubmit" "$(printf '%s\n%s\n\n%s' "$CURATED_PROMPT_HEADER" "$curated" "$CURATED_CONTEXT_TAIL")"
}

# SessionStart: ensure akm is available, then inject a compact hints block and
# a fresh index timestamp so Claude knows the stash surface area at turn 0.
session_start() {
  raw_input="$(cat)"
  sid="$(printf '%s' "$raw_input" | extract_session_id)"

  ensure_akm

  akm_available || exit 0

  # Keep the index warm in the background — never block session start.
  ( akm_run index >/dev/null & ) 2>/dev/null || true

  hints="$(akm_run --format text -q hints)"
  curated="$(akm_run --for-agent --format text --detail summary -q curate --limit "$CURATE_LIMIT" $(build_run_scope_args "$sid"))"
  [ -n "$(printf '%s' "$hints" | tr -d ' \t\n\r')" ] || [ -n "$(printf '%s' "$curated" | tr -d ' \t\n\r')" ] || exit 0

  body="$SESSION_START_HEADER"
  if [ -n "$(printf '%s' "$hints" | tr -d ' \t\n\r')" ]; then
    body="$(printf '%s\n\n%s' "$body" "$hints")"
  fi
  if [ -n "$(printf '%s' "$curated" | tr -d ' \t\n\r')" ]; then
    body="$(printf '%s\n\n%s\n\n%s\n\n%s' "$body" "$CURATED_SESSION_HEADER" "$curated" "$CURATED_CONTEXT_TAIL")"
  fi
  body="$(printf '%s\n\n%s' "$body" "$SESSION_START_FOOTER")"
  emit_hook_context "SessionStart" "$body"
}

# Capture a memory from the session buffer when the session ends or before the
# context is compacted. This is the compound-engineering loop: every session
# that touched assets writes a short memory that future searches can surface.
capture_memory() {
  reason="${MODE:-session-end}"
  [ "$AUTO_MEMORY" = "1" ] || exit 0
  akm_available || exit 0

  raw_input="$(cat)"
  sid="$(printf '%s' "$raw_input" | extract_session_id)"
  [ -n "$sid" ] || exit 0

  buffer="$SESSIONS_DIR/$sid.md"
  [ -s "$buffer" ] || exit 0

  # Require at least two observations before persisting — avoids saving
  # single-event noise as a memory.
  entries="$(grep -c '^## ' "$buffer" 2>/dev/null || printf '0')"
  if [ "${entries:-0}" -lt 2 ]; then
    rm -f "$buffer"
    exit 0
  fi

  date_tag="$(date -u +%Y%m%d)"
  short_sid="$(printf '%s' "$sid" | cut -c1-8)"
  name="claude-session-${date_tag}-${short_sid}"

  {
    printf '# Session summary (%s)\n' "$(timestamp)"
    printf 'Reason: %s\n' "$reason"
    printf 'Session: %s\n\n' "$sid"
    cat "$buffer"
  } | akm_run --format json -q remember --name "$name" --force >/dev/null

  append_log "$MEMORY_LOG" "system" "captured" "memory:$name" "$reason"
  rm -f "$buffer"
}

case "$COMMAND" in
  ensure-akm)
    ensure_akm
    ;;
  session-start)
    session_start
    ;;
  user-feedback)
    record_user_feedback
    ;;
  curate-prompt)
    curate_prompt
    ;;
  post-tool)
    record_post_tool
    ;;
  auto-feedback)
    auto_feedback
    ;;
  capture-memory)
    capture_memory
    ;;
  *)
    echo "Unknown command: $COMMAND" >&2
    exit 1
    ;;
esac
