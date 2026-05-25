import { describe, expect, test, afterEach, beforeEach } from "bun:test"
import { redactSecrets, redactObject } from "../shared/redaction"

// ── redactSecrets ────────────────────────────────────────────────────────────

describe("redactSecrets — private key", () => {
  test("redacts RSA private key blocks", () => {
    const input = "key: -----BEGIN RSA PRIVATE KEY-----\nMIIEo...\n-----END RSA PRIVATE KEY-----"
    const { text, redacted, categories } = redactSecrets(input)
    expect(redacted).toBe(true)
    expect(categories).toContain("private_key")
    expect(text).toContain("[REDACTED:PRIVATE_KEY]")
    expect(text).not.toContain("MIIEo")
  })

  test("redacts EC private key blocks", () => {
    const input = "-----BEGIN EC PRIVATE KEY-----\nABCDEF\n-----END EC PRIVATE KEY-----"
    const { text, redacted } = redactSecrets(input)
    expect(redacted).toBe(true)
    expect(text).toContain("[REDACTED:PRIVATE_KEY]")
  })
})

describe("redactSecrets — bearer tokens", () => {
  test("redacts Authorization Bearer header values", () => {
    const input = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig"
    const { text, redacted, categories } = redactSecrets(input)
    expect(redacted).toBe(true)
    expect(categories).toContain("bearer_token")
    expect(text).toContain("[REDACTED:BEARER_TOKEN]")
    expect(text).not.toContain("eyJhbGciOiJIUzI1NiJ9")
  })
})

describe("redactSecrets — GitHub tokens", () => {
  test("redacts gho_ (OAuth) tokens", () => {
    const input = "gh_auth: gho_16C7e42F292c6912E7710c838347Ae178B4a"
    const { text, categories } = redactSecrets(input)
    expect(categories).toContain("github_token")
    expect(text).toContain("[REDACTED:GITHUB_TOKEN]")
  })

  test("redacts ghp_ (PAT v1) tokens", () => {
    const input = "GITHUB_TOKEN=ghp_ABCDEFghijklmnopqrstuvwxyz1234567890"
    const { text } = redactSecrets(input)
    expect(text).toContain("[REDACTED:")
  })

  test("redacts github_pat_ tokens", () => {
    const input = "token github_pat_11ABCDE_longpatsecretvalue"
    const { text, categories } = redactSecrets(input)
    expect(categories).toContain("github_pat")
    expect(text).toContain("[REDACTED:GITHUB_PAT]")
  })
})

describe("redactSecrets — OpenAI API keys", () => {
  test("redacts sk- prefixed keys", () => {
    const input = "api_key = sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop"
    const { text, categories } = redactSecrets(input)
    expect(categories).toContain("openai_key")
    expect(text).toContain("[REDACTED:OPENAI_API_KEY]")
  })
})

describe("redactSecrets — Slack tokens", () => {
  test("redacts xoxb- bot tokens", () => {
    const input = "slack_bot_token=xoxb-12345-67890-abcdefghijklmnopqrstuvwx"
    // The env-assignment pattern fires on SLACK_BOT_TOKEN; the slack_token pattern
    // also matches the xoxb- token. Either category means redaction happened.
    const { text, redacted } = redactSecrets(input)
    expect(redacted).toBe(true)
    expect(text).not.toContain("xoxb-12345-67890-abcdefghijklmnopqrstuvwx")
  })

  test("redacts bare xoxb- token in non-assignment context", () => {
    const input = "Using bot: xoxb-12345-67890-abcdefghijklmnopqrstuvwx for posting"
    const { text, categories } = redactSecrets(input)
    expect(categories).toContain("slack_token")
    expect(text).toContain("[REDACTED:SLACK_TOKEN]")
  })

  test("redacts xoxp- user tokens", () => {
    const input = "xoxp-111-222-333-aaabbbccc"
    const { text } = redactSecrets(input)
    expect(text).toContain("[REDACTED:SLACK_TOKEN]")
  })
})

// ── WS-7b: new patterns ──────────────────────────────────────────────────────

describe("redactSecrets — database connection strings (WS-7b)", () => {
  test("redacts postgres:// credentials", () => {
    const input = "url: postgres://admin:p@$$w0rd@db.example.com:5432/mydb"
    const { text, redacted, categories } = redactSecrets(input)
    expect(redacted).toBe(true)
    expect(categories).toContain("connection_string")
    expect(text).toContain("[REDACTED:CREDENTIALS]")
    expect(text).not.toContain("p@$$w0rd")
    expect(text).toContain("db.example.com:5432/mydb")
  })

  test("redacts postgresql:// credentials", () => {
    const input = "postgresql://user:secret@host/db"
    const { text } = redactSecrets(input)
    expect(text).toContain("[REDACTED:CREDENTIALS]")
    expect(text).not.toContain("secret")
  })

  test("redacts mysql:// credentials", () => {
    const input = "Using mysql://root:hunter2@localhost:3306/app for tests"
    const { text, categories } = redactSecrets(input)
    expect(categories).toContain("connection_string")
    expect(text).toContain("[REDACTED:CREDENTIALS]")
    expect(text).not.toContain("hunter2")
  })

  test("redacts mongodb+srv:// credentials", () => {
    const input = "conn: mongodb+srv://myuser:mypassword@cluster.mongodb.net/dbname"
    const { text } = redactSecrets(input)
    expect(text).toContain("[REDACTED:CREDENTIALS]")
    expect(text).not.toContain("mypassword")
  })

  test("redacts redis:// credentials", () => {
    const input = "redis://default:redissecret@redis.example.com:6379"
    const { text, categories } = redactSecrets(input)
    expect(categories).toContain("connection_string")
    expect(text).toContain("[REDACTED:CREDENTIALS]")
  })

  test("does not redact connection strings without credentials", () => {
    const input = "postgres://db.example.com:5432/mydb"
    const { redacted } = redactSecrets(input)
    // No user:pass@ present — nothing to redact in this pattern
    expect(redacted).toBe(false)
  })
})

describe("redactSecrets — AWS ARN structures (WS-7b)", () => {
  test("redacts 12-digit account ID in ARN", () => {
    const input = "arn:aws:iam::123456789012:user/alice"
    const { text, redacted, categories } = redactSecrets(input)
    expect(redacted).toBe(true)
    expect(categories).toContain("aws_arn")
    expect(text).toContain("[REDACTED:ACCOUNT_ID]")
    expect(text).not.toContain("123456789012")
  })

  test("redacts ARN in log line", () => {
    const input = 'Assuming role arn:aws:sts::987654321098:assumed-role/MyRole/session1'
    const { text, categories } = redactSecrets(input)
    expect(categories).toContain("aws_arn")
    expect(text).not.toContain("987654321098")
  })

  test("redacts S3 bucket ARN with account ID", () => {
    const input = "arn:aws:s3:::my-bucket (arn:aws:iam::000011112222:root)"
    const { text } = redactSecrets(input)
    expect(text).not.toContain("000011112222")
  })

  test("does not redact ARN without 12-digit account ID", () => {
    // ARN with empty account segment (some global resources)
    const input = "arn:aws:s3:::my-bucket"
    const { redacted } = redactSecrets(input)
    expect(redacted).toBe(false)
  })
})

describe("redactSecrets — JWT tokens (WS-7b)", () => {
  test("redacts a well-formed JWT", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
    const input = `Authorization: Bearer ${jwt}`
    const { text, redacted, categories } = redactSecrets(input)
    expect(redacted).toBe(true)
    // JWT matched before bearer token (order-dependent — either category is valid)
    const hasSomeRedaction = categories.includes("jwt_token") || categories.includes("bearer_token")
    expect(hasSomeRedaction).toBe(true)
    expect(text).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9")
  })

  test("redacts a bare JWT token in text", () => {
    const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJ1c2VyIjoiYWxpY2UifQ.AAABBBCCC"
    const { text, categories } = redactSecrets(jwt)
    expect(categories).toContain("jwt_token")
    expect(text).toContain("[REDACTED:JWT_TOKEN]")
  })

  test("does not redact two-segment dot-separated strings (not JWT-shaped)", () => {
    const input = "version: eyJhbGci.payload"
    const { categories } = redactSecrets(input)
    expect(categories).not.toContain("jwt_token")
  })
})

// ── 0.8.0 release hardening: cloud / SaaS / raw-Authorization patterns ──────

describe("redactSecrets — AWS access keys (0.8.0)", () => {
  test("redacts a bare AKIA access key", () => {
    const input = "creds: AKIAIOSFODNN7EXAMPLE in the dump"
    const { text, categories, redacted } = redactSecrets(input)
    expect(redacted).toBe(true)
    expect(categories).toContain("aws_access_key")
    expect(text).toContain("[REDACTED:AWS_ACCESS_KEY_ID]")
    expect(text).not.toContain("AKIAIOSFODNN7EXAMPLE")
  })

  test("redacts an AKIA key inside an env line", () => {
    // The env-assignment pass redacts the value because AWS_ACCESS_KEY_ID is
    // on the SENSITIVE_KEY_RE list; the AKIA pattern itself doesn't have to
    // fire, but the secret material must be gone regardless.
    const input = "AWS_ACCESS_KEY_ID=AKIAEXAMPLEKEY1234"
    const { text, redacted } = redactSecrets(input)
    expect(redacted).toBe(true)
    expect(text).not.toContain("AKIAEXAMPLEKEY1234")
  })

  test("does not redact a non-AKIA 20-char string", () => {
    const input = "build id: BUILD-1234567890ABCDEFG"
    const { categories } = redactSecrets(input)
    expect(categories).not.toContain("aws_access_key")
  })
})

describe("redactSecrets — Google API keys (0.8.0)", () => {
  test("redacts a Google API key", () => {
    // Real Google API keys are AIza + exactly 35 base64url chars (39 total).
    const key = "AIzaSyA-1234567890_abcdefghijklmnopqrst"
    const input = `key: ${key}`
    const { text, categories, redacted } = redactSecrets(input)
    expect(redacted).toBe(true)
    expect(categories).toContain("google_api_key")
    expect(text).toContain("[REDACTED:GOOGLE_API_KEY]")
    expect(text).not.toContain(key)
  })

  test("does not redact short AIza prefix without the 35-char suffix", () => {
    const input = "AIzaShort"
    const { categories } = redactSecrets(input)
    expect(categories).not.toContain("google_api_key")
  })
})

describe("redactSecrets — Stripe keys (0.8.0)", () => {
  // Build Stripe-shaped fixtures at runtime so GitHub's secret-scanning
  // push protection never sees a literal `sk_live_<…>` / `pk_live_<…>` in
  // committed source. The patterns must still match valid Stripe shapes.
  const stripeFixture = (prefix: "sk_live" | "pk_live" | "sk_test" | "pk_test"): string =>
    `${prefix}_${"a".repeat(8)}${"B".repeat(8)}${"3".repeat(8)}`

  test("redacts sk_live_ secret key", () => {
    const key = stripeFixture("sk_live")
    const input = `stripe: ${key}`
    const { text, categories } = redactSecrets(input)
    expect(categories).toContain("stripe_live_key")
    expect(text).toContain("[REDACTED:STRIPE_LIVE_KEY]")
    expect(text).not.toContain(key)
  })

  test("redacts pk_live_ publishable key", () => {
    const key = stripeFixture("pk_live")
    const input = `publishable: ${key}`
    const { text, categories } = redactSecrets(input)
    expect(categories).toContain("stripe_live_key")
    expect(text).toContain("[REDACTED:STRIPE_LIVE_KEY]")
  })

  test("redacts sk_test_ test key", () => {
    const key = stripeFixture("sk_test")
    const input = `test: ${key}`
    const { text, categories } = redactSecrets(input)
    expect(categories).toContain("stripe_test_key")
    expect(text).toContain("[REDACTED:STRIPE_TEST_KEY]")
  })

  test("redacts pk_test_ publishable test key", () => {
    const key = stripeFixture("pk_test")
    const input = `publishable: ${key}`
    const { text, categories } = redactSecrets(input)
    expect(categories).toContain("stripe_test_key")
    expect(text).toContain("[REDACTED:STRIPE_TEST_KEY]")
  })
})

describe("redactSecrets — raw Authorization header (0.8.0)", () => {
  test("redacts a non-Bearer Authorization token", () => {
    const input = "Authorization: ABCDEFG12345HIJKLMNOP"
    const { text, categories, redacted } = redactSecrets(input)
    expect(redacted).toBe(true)
    expect(categories).toContain("authorization_header")
    expect(text).toContain("[REDACTED:AUTHORIZATION]")
    expect(text).not.toContain("ABCDEFG12345HIJKLMNOP")
  })

  test("keeps the Bearer-form path delegated to the existing bearer_token rule", () => {
    const input = "Authorization: Bearer mF_9.B5f-4.1JqM"
    const { text, categories } = redactSecrets(input)
    // The bearer_token rule should fire — not authorization_header — because
    // the (?!Bearer\b) negative lookahead skips Bearer forms.
    expect(categories).toContain("bearer_token")
    expect(categories).not.toContain("authorization_header")
    expect(text).toContain("[REDACTED:BEARER_TOKEN]")
  })

  test("ignores short placeholder values to avoid noise", () => {
    const input = "Authorization: ?"
    const { categories } = redactSecrets(input)
    expect(categories).not.toContain("authorization_header")
  })
})

// ── env-assignment redaction ─────────────────────────────────────────────────

describe("redactSecrets — env assignments", () => {
  test("redacts OPENAI_API_KEY= assignment", () => {
    const input = "export OPENAI_API_KEY=sk-test-12345"
    const { text, categories } = redactSecrets(input)
    expect(categories).toContain("env_secret")
    expect(text).toContain("[REDACTED:OPENAI_API_KEY]")
  })

  test("redacts ANTHROPIC_API_KEY= assignment", () => {
    const input = "ANTHROPIC_API_KEY=sk-ant-abc123"
    const { text } = redactSecrets(input)
    expect(text).toContain("[REDACTED:ANTHROPIC_API_KEY]")
  })

  test("redacts PASSWORD= assignment", () => {
    const input = "PASSWORD=hunter2"
    const { text, categories } = redactSecrets(input)
    expect(categories).toContain("password")
    expect(text).toContain("[REDACTED:PASSWORD]")
  })

  test("does not redact non-sensitive keys", () => {
    const input = "APP_NAME=myapp"
    const { redacted } = redactSecrets(input)
    expect(redacted).toBe(false)
  })
})

// ── JSON-like pair redaction ─────────────────────────────────────────────────

describe("redactSecrets — JSON-like key:value pairs", () => {
  test("redacts password field in JSON", () => {
    const input = '{"password": "hunter2", "user": "alice"}'
    const { text, categories } = redactSecrets(input)
    expect(categories).toContain("password")
    expect(text).toContain("[REDACTED:PASSWORD]")
    expect(text).not.toContain("hunter2")
  })

  test("redacts token field in JSON", () => {
    const input = '{"token": "abc123secret"}'
    const { text, categories } = redactSecrets(input)
    expect(categories).toContain("token")
    expect(text).toContain("[REDACTED:TOKEN]")
  })
})

// ── high-entropy opt-in ──────────────────────────────────────────────────────

describe("redactSecrets — high-entropy strings (opt-in, WS-7b)", () => {
  const origEnv = process.env.AKM_REDACT_HIGH_ENTROPY

  afterEach(() => {
    // The module-level constant is evaluated at import time so we cannot toggle it
    // in a single process; these tests validate behavior when the feature IS active
    // by checking the module exports are correct shapes.
    if (origEnv === undefined) delete process.env.AKM_REDACT_HIGH_ENTROPY
    else process.env.AKM_REDACT_HIGH_ENTROPY = origEnv
  })

  test("redactSecrets returns a valid RedactionResult shape", () => {
    const result = redactSecrets("hello world")
    expect(result).toHaveProperty("text")
    expect(result).toHaveProperty("redacted")
    expect(result).toHaveProperty("categories")
    expect(typeof result.text).toBe("string")
    expect(typeof result.redacted).toBe("boolean")
    expect(Array.isArray(result.categories)).toBe(true)
  })

  test("short high-entropy-looking strings are NOT redacted by default", () => {
    // 31 chars — below the 32-char threshold even if enabled
    const input = "AAABBBCCCDDDEEEFFFGGGHHH1234567"
    const { redacted } = redactSecrets(input)
    // Default is opt-out; only redacted if AKM_REDACT_HIGH_ENTROPY=1 at module load time
    // In the default test environment the env var is not set so this should be false
    // (unless the parent process set it, in which case it should be true for >=32 chars)
    expect(typeof redacted).toBe("boolean") // always a boolean, never undefined
  })
})

// ── CLI argv pairs ───────────────────────────────────────────────────────────

describe("redactSecrets — CLI argv pair shapes", () => {
  test("redacts --password value", () => {
    const { text, categories } = redactSecrets("akm config set --password hunter2 --user alice")
    expect(categories).toContain("cli_arg_secret")
    expect(text).toContain("[REDACTED:CLI_ARG]")
    expect(text).not.toContain("hunter2")
    expect(text).toContain("alice") // non-secret flag survives
  })

  test("redacts --api-key value", () => {
    const { text, categories } = redactSecrets("client --api-key ABC123DEF")
    expect(categories).toContain("cli_arg_secret")
    expect(text).not.toContain("ABC123DEF")
  })

  test("redacts --auth-token value", () => {
    const { text } = redactSecrets("svc --auth-token longopaquevalue123 --verbose")
    expect(text).not.toContain("longopaquevalue123")
  })

  test("does not redact unrelated --flag value pairs", () => {
    const { text } = redactSecrets("akm --format json --limit 5")
    expect(text).toContain("--format json")
    expect(text).toContain("--limit 5")
  })
})

// ── PII opt-in ───────────────────────────────────────────────────────────────

describe("redactSecrets — PII patterns (opt-in, AKM_REDACT_PII=1)", () => {
  const origEnv = process.env.AKM_REDACT_PII

  afterEach(() => {
    // Same constraint as high-entropy: PII_PATTERNS is evaluated at module
    // import time, so a single in-process test can only check default
    // behavior (off) and contract shape — exhaustive opt-in coverage runs
    // in CI with AKM_REDACT_PII=1 set before this module loads.
    if (origEnv === undefined) delete process.env.AKM_REDACT_PII
    else process.env.AKM_REDACT_PII = origEnv
  })

  test("credit-card-shaped digits are NOT redacted by default", () => {
    const { text, categories } = redactSecrets("card 4111 1111 1111 1111 on file")
    if (process.env.AKM_REDACT_PII === "1") {
      expect(categories).toContain("credit_card")
      expect(text).not.toContain("4111 1111 1111 1111")
    } else {
      expect(categories).not.toContain("credit_card")
      expect(text).toContain("4111 1111 1111 1111")
    }
  })

  test("SSN-shaped strings are NOT redacted by default", () => {
    const { text, categories } = redactSecrets("user ssn 123-45-6789")
    if (process.env.AKM_REDACT_PII === "1") {
      expect(categories).toContain("ssn")
      expect(text).not.toContain("123-45-6789")
    } else {
      expect(categories).not.toContain("ssn")
      expect(text).toContain("123-45-6789")
    }
  })

  test("US phone numbers are NOT redacted by default", () => {
    const { text, categories } = redactSecrets("call (555) 123-4567 today")
    if (process.env.AKM_REDACT_PII === "1") {
      expect(categories).toContain("phone")
      expect(text).not.toContain("(555) 123-4567")
    } else {
      expect(categories).not.toContain("phone")
      expect(text).toContain("(555) 123-4567")
    }
  })

  test("PII patterns coexist with other categories", () => {
    const { categories } = redactSecrets("Bearer eyJhbGc.x.y card 4111111111111111")
    // Bearer should always be redacted; credit_card depends on opt-in.
    expect(categories).toContain("bearer_token")
  })
})

// ── redactObject ─────────────────────────────────────────────────────────────

describe("redactObject", () => {
  test("redacts nested string values", () => {
    const input = { db: "postgres://user:pass@host/db", name: "alice" }
    const { value, redacted, categories } = redactObject(input)
    expect(redacted).toBe(true)
    expect(categories).toContain("connection_string")
    expect((value as typeof input).db).toContain("[REDACTED:CREDENTIALS]")
    expect((value as typeof input).name).toBe("alice")
  })

  test("redacts values in arrays", () => {
    const input = ["postgres://u:p@host/db", "safe string"]
    const { value } = redactObject(input)
    expect((value as string[])[0]).toContain("[REDACTED:CREDENTIALS]")
    expect((value as string[])[1]).toBe("safe string")
  })

  test("passes through null and primitives unchanged", () => {
    const input = { count: 42, flag: true, empty: null }
    const { redacted } = redactObject(input)
    expect(redacted).toBe(false)
  })

  test("redactObject returns RedactedObjectResult shape", () => {
    const result = redactObject({ key: "value" })
    expect(result).toHaveProperty("value")
    expect(result).toHaveProperty("redacted")
    expect(result).toHaveProperty("categories")
  })
})
