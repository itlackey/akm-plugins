// Tokenized assessment of risky `akm` CLI invocations.
//
// Shared between the Claude Code plugin (claude/hooks/akm-hook.ts) and the
// OpenCode plugin (opencode/index.ts) so both harnesses block the same set of
// commands using the same logic.
//
// Why tokenized matching: a regex against the raw command string (e.g.
// /\bakm\s+vault\s+set\b/) fires on any prose mention — commit messages,
// release notes, heredoc bodies, README quotes — because the input is the
// entire bash argv concatenated. The matcher splits the raw command into
// shell pipe/operator segments, then tokenizes each segment and checks
// whether the **leading token** is the `akm` binary. Subcommand positions
// (`sub`, `subSub`) are then read relative to that anchor, so prose mentions
// of risky verbs inside arguments to other binaries (`git commit -m "...akm
// vault set..."`, `echo "akm vault set ..."`, `bun -e "...akm vault set..."`)
// never match — only real `akm <verb>` invocations do, including pipe-fed
// ones (`printf ... | akm vault set ...`).

export type RiskyCommandAssessment = {
  category: string
  reason: string
  approval: string
}

// Quote-aware shell tokenizer. Splits on whitespace but respects single,
// double, and backtick quotes. Intentionally simple: does not handle escaped
// quotes inside the same quote style, $(...) expansion, or process
// substitution. Sufficient for "did the user invoke `akm <sub>`" checks; not
// a full shell parser.
export function splitArguments(raw: string): string[] {
  if (!raw.trim()) return []
  const args: string[] = []
  const re = /"([^"]*)"|'([^']*)'|`([^`]*)`|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(raw)) !== null) {
    args.push(match[1] ?? match[2] ?? match[3] ?? match[4] ?? "")
  }
  return args
}

// Split a raw shell command into top-level pipe/operator segments while
// respecting quotes. Splits on `|`, `||`, `&&`, `;`. Quoted regions (single,
// double, backtick) are passed through verbatim so that operators *inside*
// quoted prose (e.g. `git commit -m "fix: a | b"`) do not produce a spurious
// segment boundary. Inside double quotes, a backslash escapes the next char
// so that `git commit -m "...\"akm vault set\"..."` stays as a single
// segment whose leading token remains `git`.
//
// Not a full shell parser: does not expand $(...), process substitution,
// here-docs, or `2>&1` redirections (redirection operators are left attached
// to the current segment, which is fine — we only care about which binary
// each segment invokes).
export function splitPipeSegments(raw: string): string[] {
  const segments: string[] = []
  let current = ""
  let quote: string | null = null
  let i = 0
  while (i < raw.length) {
    const ch = raw[i]
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < raw.length) {
        current += ch + raw[i + 1]
        i += 2
        continue
      }
      if (ch === quote) {
        quote = null
      }
      current += ch
      i++
      continue
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch
      current += ch
      i++
      continue
    }
    if (ch === "|" || ch === "&" || ch === ";") {
      const two = raw.substring(i, i + 2)
      if (two === "||" || two === "&&") {
        if (current.trim()) segments.push(current.trim())
        current = ""
        i += 2
        continue
      }
      if (ch === "|" || ch === ";") {
        if (current.trim()) segments.push(current.trim())
        current = ""
        i++
        continue
      }
    }
    current += ch
    i++
  }
  if (current.trim()) segments.push(current.trim())
  return segments
}

function isAkmInvocation(token: string | undefined): boolean {
  if (!token) return false
  if (token === "akm") return true
  if (token.endsWith("/akm")) return true
  if (token.endsWith("\\akm.exe")) return true
  if (token.endsWith("/akm.exe")) return true
  return false
}

// Strip leading env-var assignments (`FOO=bar BAZ=qux akm <verb>`) so the
// anchor check sees `akm` as the effective leading token.
function dropEnvPrefixes(tokens: string[]): string[] {
  let i = 0
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i] ?? "")) {
    i++
  }
  return tokens.slice(i)
}

// Documented loader pattern: `eval "$(akm vault load vault:<name>)"`. The
// outer `eval` is the real invocation; the inner `akm vault load` is the
// vault read that the user has explicitly opted into by piping to eval.
// Treat as safe — the user wrote this exact form.
const EVAL_VAULT_LOAD_PATTERN = /^\s*eval\s+["']?\$\(akm\s+vault\s+load\s+/

export function assessRiskyAkmCommand(command: string): RiskyCommandAssessment | undefined {
  const normalized = command.trim()
  if (!normalized) return undefined

  if (EVAL_VAULT_LOAD_PATTERN.test(normalized)) return undefined

  // Walk each pipe-/operator-bounded segment and look for one whose leading
  // token is an `akm` invocation. Anchoring to the leading token (rather
  // than searching the full argv for the word "akm") is what prevents false
  // positives on prose mentions of risky verbs inside arguments to other
  // binaries (`git commit -m "...akm vault set..."`, `echo "akm vault set
  // ..."`). Pipe-fed real invocations (`printf ... | akm vault set ...`)
  // still match because they form their own segment whose leading token is
  // `akm`.
  const segments = splitPipeSegments(normalized)
  let tokens: string[] | undefined
  for (const segment of segments) {
    const segArgs = dropEnvPrefixes(splitArguments(segment))
    if (isAkmInvocation(segArgs[0])) {
      tokens = segArgs.slice(1)
      break
    }
  }
  if (!tokens) return undefined

  const sub = tokens[0]
  const subSub = tokens[1]

  // 0.8.0 promoted accept/reject/revert to top-level verbs. The legacy
  // `proposal accept|reject` two-token form never existed in akm 0.8.0
  // (cli.ts has no `proposal` subcommand — only `proposals`, `accept`,
  // `reject`, `revert`, `show proposal <id>`, `diff <id>`). The bare-verb
  // arm is the canonical match.
  if (sub === "accept") {
    return {
      category: "proposal-accept",
      reason: "Proposal acceptance changes curated AKM content.",
      approval: "Ask the user to approve `akm accept <id>`.",
    }
  }

  if (sub === "reject") {
    return {
      category: "proposal-reject",
      reason: "Proposal rejection is a durable curation decision.",
      approval: 'Ask the user to approve `akm reject <id> --reason "..."`.',
    }
  }

  // `akm revert <id>` rolls back an accepted proposal — same impact class
  // as accept/reject (durable curation decision). Gate it explicitly.
  if (sub === "revert") {
    return {
      category: "proposal-revert",
      reason: "Reverting an accepted proposal rolls back curated AKM content.",
      approval: "Ask the user to approve `akm revert <id>`.",
    }
  }

  // `akm tasks add|remove|enable|disable|run` registers, mutates, or
  // executes OS-native scheduler entries (cron / launchd / schtasks). All
  // five verbs have durable side effects outside the stash.
  if (sub === "tasks" && ["add", "remove", "enable", "disable", "run"].includes(subSub)) {
    return {
      category: "tasks-mutate",
      reason: `\`akm tasks ${subSub}\` changes or runs an OS scheduler entry (cron / launchd / schtasks).`,
      approval: `Ask the user to approve the exact \`akm tasks ${subSub} ...\` command.`,
    }
  }

  if (sub === "save" && tokens.includes("--push")) {
    return {
      category: "save-push",
      reason: "Pushing stash changes must be explicitly approved.",
      approval: "Ask the user to approve `akm save --push`.",
    }
  }

  if (sub === "remove") {
    return {
      category: "remove",
      reason: "Removing AKM sources is destructive.",
      approval: "Ask the user to approve the exact `akm remove ...` command.",
    }
  }

  if (sub === "vault" && (subSub === "create" || subSub === "set" || subSub === "unset" || subSub === "load" || subSub === "show")) {
    return {
      category: `vault-${subSub}`,
      reason: "Vault access or mutation is sensitive.",
      approval: `Ask the user to approve the exact \`akm vault ${subSub} ...\` command.`,
    }
  }

  if (sub === "config" && subSub === "set" && tokens[2]) {
    const key = tokens[2]
    if (key.startsWith("llm.features.") || key === "registries" || key === "searchPaths" || key === "stashDir") {
      return {
        category: "config-mutation",
        reason: "AKM config mutations alter autonomous behavior or trust boundaries.",
        approval: `Ask the user to approve the exact \`akm config set ${key} ...\` command.`,
      }
    }
  }

  if (sub === "update" && tokens.includes("--all")) {
    return {
      category: "update-all",
      reason: "Updating all AKM kits changes many assets at once.",
      approval: "Ask the user to approve `akm update --all`.",
    }
  }

  if (sub === "upgrade") {
    return {
      category: "upgrade",
      reason: "Upgrading the AKM CLI changes the toolchain.",
      approval: "Ask the user to approve the exact `akm upgrade` command.",
    }
  }

  if ((sub === "add" || (sub === "wiki" && subSub === "register")) && tokens.includes("--trust")) {
    return {
      category: "trust-registration",
      reason: "Trusted source registration bypasses safety checks.",
      approval: "Ask the user to approve the exact command before adding a trusted source.",
    }
  }

  return undefined
}

export function blockedCommandMessage(command: string, assessment: RiskyCommandAssessment): string {
  return [
    `Blocked risky AKM command: ${command}`,
    assessment.reason,
    assessment.approval,
    "Retry only after explicit user approval in this conversation.",
  ].join("\n")
}
