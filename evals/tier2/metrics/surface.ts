// Snapshot the plugin's public surface: tools, slash commands, agents,
// hooks. Diff'ing two snapshots flags accidental removals (which can break
// users) and intentional additions (which authors should document).
//
// Source of truth:
//  - Claude commands → claude/commands/*.md filenames
//  - Claude agents → claude/agents/*.md filenames
//  - Claude hooks → claude/.claude-plugin/plugin.json `hooks` keys
//  - OpenCode tools → regex over opencode/index.ts exported tool keys
//  - OpenCode commands → opencode/commands/*.md filenames
//  - OpenCode agents → opencode/agent/*.md filenames

import { readdirSync, readFileSync, existsSync } from "node:fs"
import path from "node:path"
import type { MetricResult } from "../../lib/report"

export type SurfaceSnapshot = {
  claude: {
    commands: string[]
    agents: string[]
    hooks: string[]
    skills: string[]
  }
  opencode: {
    tools: string[]
    commands: string[]
    agents: string[]
  }
  // Flat lists used by the diff tool — easier to compare than nested objects.
  tools: string[]
  commands: string[]
  hooks: string[]
}

function listMarkdown(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""))
    .sort()
}

function listSubdirs(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
}

export function snapshotSurface(repoRoot: string): SurfaceSnapshot {
  const claudeCommands = listMarkdown(path.join(repoRoot, "claude/commands"))
  const claudeAgents = listMarkdown(path.join(repoRoot, "claude/agents"))
  const claudeSkills = listSubdirs(path.join(repoRoot, "claude/skills"))
  const pluginJsonPath = path.join(repoRoot, "claude/.claude-plugin/plugin.json")
  let claudeHooks: string[] = []
  if (existsSync(pluginJsonPath)) {
    const plugin = JSON.parse(readFileSync(pluginJsonPath, "utf8"))
    claudeHooks = Object.keys(plugin.hooks ?? {}).sort()
  }

  const opencodeIndex = path.join(repoRoot, "opencode/index.ts")
  let opencodeTools: string[] = []
  if (existsSync(opencodeIndex)) {
    const body = readFileSync(opencodeIndex, "utf8")
    const re = /\b(akm_[a-z_]+):\s*tool\(/g
    const seen = new Set<string>()
    for (const m of body.matchAll(re)) seen.add(m[1])
    opencodeTools = [...seen].sort()
  }
  const opencodeCommands = listMarkdown(path.join(repoRoot, "opencode/commands"))
  const opencodeAgents = listMarkdown(path.join(repoRoot, "opencode/agent"))

  return {
    claude: {
      commands: claudeCommands,
      agents: claudeAgents,
      hooks: claudeHooks,
      skills: claudeSkills,
    },
    opencode: {
      tools: opencodeTools,
      commands: opencodeCommands,
      agents: opencodeAgents,
    },
    // The diff tool consumes these flat lists. Prefix each entry with its
    // origin so claude:akm-search and opencode:akm_search don't collide.
    tools: opencodeTools.map((t) => `opencode:${t}`).sort(),
    commands: [
      ...claudeCommands.map((c) => `claude:${c}`),
      ...opencodeCommands.map((c) => `opencode:${c}`),
    ].sort(),
    hooks: [
      ...claudeHooks.map((h) => `claude:${h}`),
    ].sort(),
  }
}

export function runSurfaceMetric(repoRoot: string): MetricResult {
  const snap = snapshotSurface(repoRoot)
  return {
    name: "surface",
    values: {
      tools: snap.tools,
      commands: snap.commands,
      hooks: snap.hooks,
      claudeSkills: snap.claude.skills,
      claudeAgents: snap.claude.agents,
      opencodeAgents: snap.opencode.agents,
      toolCount: snap.tools.length,
      commandCount: snap.commands.length,
      hookCount: snap.hooks.length,
    },
    table: {
      headers: ["Component", "Count", "Items"],
      rows: [
        ["claude commands", snap.claude.commands.length, snap.claude.commands.join(", ")],
        ["claude agents", snap.claude.agents.length, snap.claude.agents.join(", ")],
        ["claude hooks", snap.claude.hooks.length, snap.claude.hooks.join(", ")],
        ["claude skills", snap.claude.skills.length, snap.claude.skills.join(", ")],
        ["opencode tools", snap.opencode.tools.length, snap.opencode.tools.join(", ")],
        ["opencode commands", snap.opencode.commands.length, snap.opencode.commands.join(", ")],
        ["opencode agents", snap.opencode.agents.length, snap.opencode.agents.join(", ")],
      ],
    },
  }
}
