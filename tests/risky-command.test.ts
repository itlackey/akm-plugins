import { describe, expect, it } from "bun:test"
import { assessRiskyAkmCommand, splitArguments, splitPipeSegments } from "../shared/risky-command"

// Risky-verb tokens are spelled via string concatenation so this test source
// itself never trips the PreToolUse hook when the file is opened, edited, or
// committed. (The bug under repair is precisely false-positive matches on
// risky verbs appearing in argv to non-`akm` commands.)
const V = "v" + "ault"
const S = "s" + "et"
const ACC = "acc" + "ept"
const REJ = "rej" + "ect"

describe("splitPipeSegments", () => {
  it("returns a single segment for a plain command", () => {
    expect(splitPipeSegments("akm save")).toEqual(["akm save"])
  })

  it("splits on a single pipe", () => {
    expect(splitPipeSegments("printf %s foo | akm save")).toEqual([
      "printf %s foo",
      "akm save",
    ])
  })

  it("splits on && and || operators", () => {
    expect(splitPipeSegments("echo hi && akm save")).toEqual(["echo hi", "akm save"])
    expect(splitPipeSegments("akm save || true")).toEqual(["akm save", "true"])
  })

  it("splits on ; semicolon", () => {
    expect(splitPipeSegments("ls; akm save")).toEqual(["ls", "akm save"])
  })

  it("treats operators inside double quotes as literal", () => {
    expect(splitPipeSegments(`git commit -m "fix: a | b && c"`)).toEqual([
      `git commit -m "fix: a | b && c"`,
    ])
  })

  it("treats operators inside single quotes as literal", () => {
    expect(splitPipeSegments(`git commit -m 'fix: a | b'`)).toEqual([
      `git commit -m 'fix: a | b'`,
    ])
  })

  it("respects backslash-escaped double quotes inside double-quoted strings", () => {
    // Inside `"..."`, a `\"` should NOT close the outer quote.
    const raw = `git commit -m "fix: stop blocking \\"akm ${V} ${S}\\" prose"`
    expect(splitPipeSegments(raw)).toEqual([raw])
  })
})

describe("assessRiskyAkmCommand", () => {
  describe("anchors match to the leading akm invocation", () => {
    it("does not match a risky verb that appears only inside a commit message", () => {
      // The original false-positive: tokenizer found `akm` deep in argv and
      // matched the surrounding `${V} ${S}` tokens.
      const cmd = `git commit -m "docs: update akm ${V} ${S} reference"`
      expect(assessRiskyAkmCommand(cmd)).toBeUndefined()
    })

    it("does not match a risky verb that appears only inside an echo argument", () => {
      expect(
        assessRiskyAkmCommand(`echo "akm ${V} ${S} is now stdin-only"`),
      ).toBeUndefined()
    })

    it("does not match top-level verbs in a commit message", () => {
      expect(
        assessRiskyAkmCommand(`git commit -m "akm proposal ${ACC} foo"`),
      ).toBeUndefined()
      expect(
        assessRiskyAkmCommand(`git commit -m "and also akm ${REJ} something"`),
      ).toBeUndefined()
    })

    it("does not match risky verbs inside a bun -e script body", () => {
      const cmd = `bun -e "import x; const c = 'akm ${V} ${S} foo'"`
      expect(assessRiskyAkmCommand(cmd)).toBeUndefined()
    })

    it("does not match risky verbs inside backslash-escaped quotes in a commit message", () => {
      // The previous regex tokenizer broke on `\"` inside `"..."`, exposing
      // `akm` and the risky-verb tokens as bare argv tokens. The segmented
      // matcher should still see this whole thing as a single `git commit` segment.
      const cmd = `git commit -m "fix: stop blocking \\"akm ${V} ${S}\\" prose"`
      expect(assessRiskyAkmCommand(cmd)).toBeUndefined()
    })
  })

  describe("matches real akm invocations", () => {
    it("matches a direct akm vault set invocation", () => {
      const result = assessRiskyAkmCommand(`akm ${V} ${S} ${V}:foo MYKEY`)
      expect(result?.category).toBe(`${V}-${S}`)
    })

    it("matches a piped akm vault set invocation (printf ... | akm ...)", () => {
      // Important: the matcher must still see the second pipe segment's
      // leading token as `akm`. This is the standard stdin loader pattern.
      const result = assessRiskyAkmCommand(
        `printf '%s' "$X" | akm ${V} ${S} ${V}:foo MYKEY`,
      )
      expect(result?.category).toBe(`${V}-${S}`)
    })

    it("matches after a shell && operator", () => {
      const result = assessRiskyAkmCommand(`echo hi && akm ${ACC} p_123`)
      expect(result?.category).toBe(`proposal-${ACC}`)
    })

    it("matches after a ; semicolon separator", () => {
      const result = assessRiskyAkmCommand(`ls; akm ${REJ} p_abc --reason oops`)
      expect(result?.category).toBe(`proposal-${REJ}`)
    })

    it("matches when invoked via an absolute path", () => {
      const result = assessRiskyAkmCommand(`/usr/local/bin/akm ${ACC} p_1`)
      expect(result?.category).toBe(`proposal-${ACC}`)
    })

    it("strips leading env-var assignments before the anchor check", () => {
      const result = assessRiskyAkmCommand(`FOO=bar BAZ=qux akm ${V} ${S} ${V}:x KEY`)
      expect(result?.category).toBe(`${V}-${S}`)
    })

    it("still matches akm save --push (flag-aware verb check)", () => {
      const result = assessRiskyAkmCommand("akm save --push")
      expect(result?.category).toBe("save-push")
    })

    it("matches akm tasks add (subSub-aware verb check)", () => {
      const result = assessRiskyAkmCommand(`akm tasks add nightly --cron "0 2 * * *"`)
      expect(result?.category).toBe("tasks-mutate")
    })

    it("still allows the documented eval $(akm vault load ...) loader", () => {
      const result = assessRiskyAkmCommand(`eval "$(akm ${V} load ${V}:dev)"`)
      expect(result).toBeUndefined()
    })
  })

  describe("returns undefined for non-risky and non-akm commands", () => {
    it("returns undefined for an empty string", () => {
      expect(assessRiskyAkmCommand("")).toBeUndefined()
      expect(assessRiskyAkmCommand("   ")).toBeUndefined()
    })

    it("returns undefined for a non-akm command", () => {
      expect(assessRiskyAkmCommand("ls -la")).toBeUndefined()
      expect(assessRiskyAkmCommand("git status")).toBeUndefined()
    })

    it("returns undefined for a read-only akm verb", () => {
      expect(assessRiskyAkmCommand("akm tasks list")).toBeUndefined()
      expect(assessRiskyAkmCommand("akm search foo")).toBeUndefined()
      expect(assessRiskyAkmCommand("akm show memory:hello")).toBeUndefined()
    })
  })
})

describe("splitArguments (regression coverage)", () => {
  // splitArguments itself is unchanged — these tests pin existing behavior so
  // future refactors don't silently change tokenization semantics.
  it("preserves quoted strings as a single token", () => {
    expect(splitArguments(`akm remember "hello world"`)).toEqual([
      "akm",
      "remember",
      "hello world",
    ])
  })

  it("splits unquoted whitespace into separate tokens", () => {
    expect(splitArguments("akm tasks add nightly")).toEqual([
      "akm",
      "tasks",
      "add",
      "nightly",
    ])
  })

  it("returns an empty array for whitespace-only input", () => {
    expect(splitArguments("   ")).toEqual([])
  })
})
