import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { extractAllRefs, validateLiveRefs, validateRefCandidates } from "../claude/shared/ref-extraction"

const tempDirs: string[] = []

function makeStash() {
  const dir = mkdtempSync(path.join(tmpdir(), "akm-ref-extraction-"))
  tempDirs.push(dir)
  return dir
}

function touch(file: string, contents = "") {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, contents)
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe("extractAllRefs", () => {
  it("matches every ref-shaped token regardless of context", () => {
    const text = [
      "Plain prose with memory:hello and knowledge:projects/akm/foo.",
      "Also task:release-checklist should be recognized.",
      "```",
      "grep -E 'memory:foo|memory:bar' file.md",
      "```",
      "JSON: {\"ref\": \"agent:bunjs-coder\"}",
      "Repeat: memory:hello (dedup)",
    ].join("\n")
    expect(extractAllRefs(text)).toEqual([
      "memory:hello",
      "knowledge:projects/akm/foo",
      "task:release-checklist",
      "memory:foo",
      "memory:bar",
      "agent:bunjs-coder",
    ])
  })

  it("returns empty list for empty input", () => {
    expect(extractAllRefs("")).toEqual([])
    expect(extractAllRefs("nothing-to-see-here")).toEqual([])
  })
})

describe("validateRefCandidates", () => {
  it("keeps only refs that resolve in the stash", () => {
    const stash = makeStash()
    touch(path.join(stash, "memories", "real-memory.md"), "---\n---\nbody")
    touch(path.join(stash, "knowledge", "projects", "akm", "release-notes.md"), "x")
    touch(path.join(stash, "skills", "rollout", "SKILL.md"), "x")

    const candidates = [
      "memory:real-memory",
      "memory:foo", // literal — does not exist
      "knowledge:projects/akm/release-notes",
      "knowledge:projects/akm/foo", // literal
      "skill:rollout",
      "agent:nonexistent",
    ]
    expect(validateRefCandidates(candidates, [stash])).toEqual([
      "knowledge:projects/akm/release-notes",
      "memory:real-memory",
      "skill:rollout",
    ])
  })

  it("strips local// prefix and rejects remote origins", () => {
    const stash = makeStash()
    touch(path.join(stash, "memories", "rollout.md"), "x")
    expect(validateRefCandidates(["local//memory:rollout", "github//memory:rollout"], [stash])).toEqual([
      "memory:rollout",
    ])
  })

  it("rejects shell-expansion, placeholder, and ACP-typed candidates", () => {
    const stash = makeStash()
    touch(path.join(stash, "memories", "real.md"), "x")
    expect(
      validateRefCandidates(
        ["memory:$(cmd)", "knowledge:${VAR}", "agent::Type", "memory:x", "memory:**", "memory:real"],
        [stash],
      ),
    ).toEqual(["memory:real"])
  })

  it("rejects refs containing shell metacharacters (pasted regex)", () => {
    const stash = makeStash()
    touch(path.join(stash, "memories", "real.md"), "x")
    expect(
      validateRefCandidates(["memory:foo|knowledge:projects/akm/foo|memory:bar", "memory:real"], [stash]),
    ).toEqual(["memory:real"])
  })

  it("returns deduped and sorted output", () => {
    const stash = makeStash()
    touch(path.join(stash, "memories", "beta.md"), "x")
    touch(path.join(stash, "memories", "alpha.md"), "x")
    expect(validateRefCandidates(["memory:beta", "memory:alpha", "memory:beta"], [stash])).toEqual([
      "memory:alpha",
      "memory:beta",
    ])
  })

  it("returns empty list when stash roots are empty", () => {
    expect(validateRefCandidates(["memory:foo"], [])).toEqual([])
  })

  it("recognises memories backed by a .derived.md sibling", () => {
    const stash = makeStash()
    touch(path.join(stash, "memories", "session-x.derived.md"), "x")
    expect(validateRefCandidates(["memory:session-x"], [stash])).toEqual(["memory:session-x"])
  })

  it("recognises knowledge refs one level deep under subdirectories", () => {
    const stash = makeStash()
    // knowledge/<category>/<name>.md — single level scan mirrors lint walker.
    touch(path.join(stash, "knowledge", "projects", "release-notes.md"), "x")
    expect(validateRefCandidates(["knowledge:release-notes"], [stash])).toEqual(["knowledge:release-notes"])
  })

  it("recognises task refs", () => {
    const stash = makeStash()
    touch(path.join(stash, "tasks", "release-checklist.md"), "x")
    expect(validateRefCandidates(["task:release-checklist"], [stash])).toEqual(["task:release-checklist"])
  })
})

describe("validateLiveRefs (transcript fixture)", () => {
  it("filters a heredoc-laden transcript down to the refs that actually exist", () => {
    const stash = makeStash()
    touch(path.join(stash, "memories", "rollout-notes.md"), "x")
    touch(path.join(stash, "agents", "bunjs-coder.md"), "x")

    const transcript = `
# Session capture (sanitized fake)

The user requested a status update on memory:rollout-notes.

Bash command (heredoc literal — must NOT survive validation):
cat <<'EOF' > /tmp/x
- pattern: memory:foo
- pattern: knowledge:projects/akm/foo
EOF

JSON dump (also must NOT survive):
{"ref": "memory:bar"}

Real dispatch:
agent:bunjs-coder ran the task.
`
    expect(validateLiveRefs(transcript, [stash])).toEqual(["agent:bunjs-coder", "memory:rollout-notes"])
  })
})
