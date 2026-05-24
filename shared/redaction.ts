import { inspect } from "node:util"

export type RedactionResult = {
  text: string
  redacted: boolean
  categories: string[]
}

export type RedactedObjectResult<T> = {
  value: T
  redacted: boolean
  categories: string[]
}

const SENSITIVE_KEY_RE = /(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|GITHUB_TOKEN|GH_TOKEN|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AZURE_[A-Z0-9_]*KEY|SLACK_BOT_TOKEN|SLACK_TOKEN|PASSWORD|PASSWD|SECRET|CONNECTION_STRING|DATABASE_URL|AKM_[A-Z0-9_]*TOKEN)/i
const SIMPLE_REPLACEMENTS: Array<{ category: string; pattern: RegExp; replacement: string }> = [
  {
    category: "private_key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED:PRIVATE_KEY]",
  },
  {
    category: "bearer_token",
    pattern: /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
    replacement: "[REDACTED:BEARER_TOKEN]",
  },
  {
    category: "github_token",
    pattern: /\bgh[pousr]_[A-Za-z0-9_]+\b/g,
    replacement: "[REDACTED:GITHUB_TOKEN]",
  },
  {
    category: "github_pat",
    pattern: /\bgithub_pat_[A-Za-z0-9_]+\b/g,
    replacement: "[REDACTED:GITHUB_PAT]",
  },
  {
    category: "openai_key",
    pattern: /\bsk-[A-Za-z0-9_-]+\b/g,
    replacement: "[REDACTED:OPENAI_API_KEY]",
  },
  {
    category: "slack_token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]+\b/g,
    replacement: "[REDACTED:SLACK_TOKEN]",
  },
  // WS-7b: Database connection strings — redact credentials portion.
  // Matches postgres://, mysql://, mongodb+srv://, mongodb://, redis:// with user:pass@ form.
  {
    category: "connection_string",
    pattern: /((?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis):\/\/)([^@\s]+@)([^\s"'`,]+)/gi,
    replacement: "$1[REDACTED:CREDENTIALS]@$3",
  },
  // WS-7b: AWS ARN structures with embedded account IDs (12-digit).
  // Matches arn:aws:...:123456789012:... patterns.
  {
    category: "aws_arn",
    pattern: /arn:aws:[a-z0-9_-]+:[a-z0-9-]*:(\d{12}):[^\s"'`,]*/gi,
    replacement: "arn:aws:...[REDACTED:ACCOUNT_ID]:...",
  },
  // WS-7b: JWT-shaped tokens — three base64url segments separated by dots (eyJ prefix).
  {
    category: "jwt_token",
    pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    replacement: "[REDACTED:JWT_TOKEN]",
  },
]

/**
 * High-entropy string redaction (WS-7b).
 *
 * Generic strings >= 32 chars matching [A-Za-z0-9+/=_-]+ that look like
 * base64/hex secrets. Disabled by default to avoid false positives (e.g.
 * long identifiers, file paths, etc.). Opt in by setting the env var:
 *
 *   AKM_REDACT_HIGH_ENTROPY=1
 *
 * The threshold is 32 chars, configurable via AKM_REDACT_ENTROPY_MIN_LEN.
 */
const HIGH_ENTROPY_ENABLED = process.env.AKM_REDACT_HIGH_ENTROPY === "1"
const HIGH_ENTROPY_MIN_LEN = Number.parseInt(process.env.AKM_REDACT_ENTROPY_MIN_LEN ?? "32", 10)
const HIGH_ENTROPY_RE = HIGH_ENTROPY_ENABLED
  ? new RegExp(`\\b[A-Za-z0-9+/=_-]{${Math.max(32, HIGH_ENTROPY_MIN_LEN)},}\\b`, "g")
  : null

function uniq(values: string[]): string[] {
  return [...new Set(values)]
}

function redactAssignments(text: string, categories: string[]): string {
  const envLineRe = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/gm
  return text.replace(envLineRe, (match, rawKey: string) => {
    const key = String(rawKey)
    if (!SENSITIVE_KEY_RE.test(key)) return match
    categories.push(key.toLowerCase().includes("password") || key.toLowerCase().includes("passwd") ? "password" : "env_secret")
    categories.push("vault_output")
    return `${key}=[REDACTED:${key}]`
  })
}

function redactJsonLikePairs(text: string, categories: string[]): string {
  const pairRe = /(["']?)(password|passwd|secret|connectionString|apiKey|token|accessKey|secretKey)(\1\s*[:=]\s*)(["']?)([^\n,}"']+)(["']?)/gi
  return text.replace(pairRe, (_match, q1: string, key: string, sep: string) => {
    const upper = key.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()
    const category = /connection/i.test(key)
      ? "connection_string"
      : /pass/i.test(key)
        ? "password"
        : /secret/i.test(key)
          ? "secret"
          : "token"
    categories.push(category)
    return `${q1}${key}${q1}${sep}[REDACTED:${upper}]`
  })
}

export function redactSecrets(input: string): RedactionResult {
  let text = input
  const categories: string[] = []

  for (const entry of SIMPLE_REPLACEMENTS) {
    if (!entry.pattern.test(text)) continue
    categories.push(entry.category)
    text = text.replace(entry.pattern, entry.replacement)
  }

  text = redactAssignments(text, categories)
  text = redactJsonLikePairs(text, categories)

  // WS-7b: Optional high-entropy string redaction (opt-in via AKM_REDACT_HIGH_ENTROPY=1).
  if (HIGH_ENTROPY_RE && HIGH_ENTROPY_RE.test(text)) {
    categories.push("high_entropy")
    HIGH_ENTROPY_RE.lastIndex = 0 // reset after .test()
    text = text.replace(HIGH_ENTROPY_RE, "[REDACTED:HIGH_ENTROPY]")
  }

  return {
    text,
    redacted: categories.length > 0,
    categories: uniq(categories),
  }
}

function normalizeObjectInput(value: unknown): unknown {
  if (typeof value === "string") return value
  if (value == null) return value
  if (typeof value === "number" || typeof value === "boolean") return value
  if (Array.isArray(value)) return value.map(normalizeObjectInput)
  if (typeof value === "object") {
    const record: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      record[key] = normalizeObjectInput(entry)
    }
    return record
  }
  return inspect(value, { depth: 4, breakLength: 120 })
}

function redactUnknown(value: unknown, categories: string[]): unknown {
  if (typeof value === "string") {
    const redacted = redactSecrets(value)
    categories.push(...redacted.categories)
    return redacted.text
  }
  if (Array.isArray(value)) return value.map((entry) => redactUnknown(entry, categories))
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      output[key] = redactUnknown(entry, categories)
    }
    return output
  }
  return value
}

export function redactObject<T>(input: T): RedactedObjectResult<T> {
  const categories: string[] = []
  const normalized = normalizeObjectInput(input)
  const value = redactUnknown(normalized, categories) as T
  return {
    value,
    redacted: categories.length > 0,
    categories: uniq(categories),
  }
}
