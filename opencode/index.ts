import { type Plugin, tool } from "@opencode-ai/plugin"
import { execFileSync, execSync } from "node:child_process"

function runCli(args: string[]): string {
  try {
    return execFileSync("akm", args, {
      encoding: "utf8",
      timeout: 60_000,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return JSON.stringify({ ok: false, error: message })
  }
}

type CliError = { ok: false; error: string }
type AssetType = "tool" | "skill" | "command" | "agent" | "knowledge" | "script"

type ShowAgentResponse = {
  type: "agent"
  name: string
  path: string
  description?: string
  prompt?: string
  toolPolicy?: unknown
  modelHint?: unknown
  registryId?: string
  editable?: boolean
}

type ShowCommandResponse = {
  type: "command"
  name: string
  path: string
  description?: string
  template?: string
  registryId?: string
  editable?: boolean
  agent?: string
}

type ShowToolResponse = {
  type: "tool"
  name: string
  path?: string
  description?: string
  runCmd?: string
  registryId?: string
  editable?: boolean
}

type SearchHit = {
  type: AssetType | "registry"
  openRef?: string
  installRef?: string
  installCmd?: string
  id?: string
  registryId?: string
  editable?: boolean
  hitSource?: "local" | "registry"
  source?: "npm" | "github"
  name?: string
  title?: string
  description?: string
  score?: number
  whyMatched?: string
  runCmd?: string
  kind?: string
  usage?: string
}

type SearchResponse = {
  hits?: SearchHit[]
  source?: "local" | "registry" | "both"
  stashDir?: string
  timing?: number
  warnings?: string[]
  tip?: string
  usageGuide?: string
}

function isShowToolResponse(value: unknown): value is ShowToolResponse {
  return !!value
    && typeof value === "object"
    && (value as { type?: unknown }).type === "tool"
}

function isShowAgentResponse(value: unknown): value is ShowAgentResponse {
  return !!value
    && typeof value === "object"
    && (value as { type?: unknown }).type === "agent"
}

function isShowCommandResponse(value: unknown): value is ShowCommandResponse {
  return !!value
    && typeof value === "object"
    && (value as { type?: unknown }).type === "command"
}

function parseCliJson<T>(raw: string): T | CliError {
  try {
    return JSON.parse(raw) as T
  } catch {
    return {
      ok: false,
      error: "Agentikit CLI returned non-JSON output",
    }
  }
}

function isCliError(value: unknown): value is CliError {
  return !!value
    && typeof value === "object"
    && "ok" in value
    && (value as { ok?: unknown }).ok === false
    && "error" in value
}

function parseModelHint(modelHint: unknown): { providerID: string; modelID: string } | undefined {
  if (typeof modelHint !== "string") return undefined
  const [providerID, ...modelParts] = modelHint.split("/")
  const modelID = modelParts.join("/")
  if (!providerID || !modelID) return undefined
  return { providerID, modelID }
}

function parseToolPolicy(toolPolicy: unknown): Record<string, boolean> | undefined {
  if (!toolPolicy || typeof toolPolicy !== "object" || Array.isArray(toolPolicy)) return undefined
  const result: Record<string, boolean> = {}
  for (const [key, value] of Object.entries(toolPolicy as Record<string, unknown>)) {
    if (typeof value === "boolean") result[key] = value
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function extractText(parts: unknown): string {
  if (!Array.isArray(parts)) return ""
  const segments: string[] = []
  for (const part of parts as Array<Record<string, unknown>>) {
    if (part?.type === "text" && typeof part.text === "string") {
      const text = part.text.trim()
      if (text) segments.push(text)
    }
  }
  return segments.join("\n\n")
}

function resolveRefInput(input: { ref?: string; query?: string }, type: AssetType): { ok: true; ref: string } | CliError {
  if (input.ref && input.ref.trim()) {
    return { ok: true, ref: input.ref.trim() }
  }

  const query = input.query?.trim()
  if (!query) {
    return { ok: false, error: "Provide either 'ref' or 'query'." }
  }

  const raw = runCli(["search", query, "--type", type, "--limit", "1", "--usage", "none", "--source", "local"])
  const parsed = parseCliJson<SearchResponse>(raw)
  if (isCliError(parsed)) return parsed

  const openRef = parsed.hits?.[0]?.openRef
  if (!openRef) {
    return { ok: false, error: `No ${type} match found for query '${query}'.` }
  }

  return { ok: true, ref: openRef }
}

async function ensureTargetSessionID(input: {
  useSubtask: boolean
  context: { sessionID: string; directory: string }
  title: string
  client: PluginClient
}): Promise<{ ok: true; sessionID: string } | CliError> {
  if (!input.useSubtask) return { ok: true, sessionID: input.context.sessionID }

  const created = await input.client.session.create({
    query: { directory: input.context.directory },
    body: { parentID: input.context.sessionID, title: input.title },
  })
  if (created.error || !created.data?.id) {
    const reason = created.error ? JSON.stringify(created.error) : "missing child session id"
    return { ok: false, error: `Failed to create child session: ${reason}` }
  }
  return { ok: true, sessionID: created.data.id }
}

function splitArguments(raw: string): string[] {
  if (!raw.trim()) return []
  const args: string[] = []
  const re = /"([^"]*)"|'([^']*)'|`([^`]*)`|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(raw)) !== null) {
    args.push(match[1] ?? match[2] ?? match[3] ?? match[4] ?? "")
  }
  return args
}

function renderCommandTemplate(template: string, rawArguments: string): string {
  const args = splitArguments(rawArguments)
  return template
    .replace(/\$ARGUMENTS/g, rawArguments)
    .replace(/\$(\d+)/g, (_m, index: string) => args[Number(index) - 1] ?? "")
}

function createSearchArgs(input: {
  query: string
  type?: AssetType | "any"
  limit?: number
  source?: "local" | "registry" | "both"
  usage?: "none" | "both" | "item" | "guide"
  defaultSource?: "local" | "registry" | "both"
}): string[] {
  const args = ["search", input.query]
  if (input.type) args.push("--type", input.type)
  if (input.limit) args.push("--limit", String(input.limit))
  if (input.source) {
    args.push("--source", input.source)
  } else if (input.defaultSource) {
    args.push("--source", input.defaultSource)
  }
  if (input.usage) args.push("--usage", input.usage)
  return args
}

type PluginClient = {
  session: {
    create: (input: {
      query: { directory: string }
      body: { parentID: string; title: string }
    }) => Promise<{ data?: { id?: string }; error?: unknown }>
    prompt: (input: {
      query: { directory: string }
      path: { id: string }
      body: {
        agent: string
        parts: Array<{ type: "text"; text: string }>
        system?: string
        model?: { providerID: string; modelID: string }
        tools?: Record<string, boolean>
      }
    }) => Promise<{ data?: { parts?: unknown }; error?: unknown }>
  }
}

export const AgentikitPlugin: Plugin = async ({ client }) => ({
  tool: {
    akm_search: tool({
      description: "Search your local stash or the Agentikit registry for tools, skills, commands, agents, scripts, and knowledge. Use source='registry' or akm_registry_search for installable community kits.",
      args: {
        query: tool.schema.string().describe("Case-insensitive substring search."),
        type: tool.schema
          .enum(["tool", "skill", "command", "agent", "knowledge", "script", "any"])
          .optional()
          .describe("Optional type filter. Defaults to 'any'."),
        limit: tool.schema.number().optional().describe("Maximum number of hits to return. Defaults to 20."),
        source: tool.schema
          .enum(["local", "registry", "both"])
          .optional()
          .describe("Search source. 'local' searches stash dirs, 'registry' searches npm/GitHub, 'both' searches all. Defaults to 'local'."),
        usage: tool.schema
          .enum(["none", "both", "item", "guide"])
          .optional()
          .describe("Usage metadata mode. Registry searches often work best with 'item' or 'none'."),
      },
      async execute({ query, type, limit, source, usage }) {
        return runCli(createSearchArgs({ query, type, limit, source, usage }))
      },
    }),
    akm_registry_search: tool({
      description: "Search the Agentikit registry only. Use this when you want installable kits from npm or GitHub without mixing in local stash results.",
      args: {
        query: tool.schema.string().describe("Search query for installable registry kits."),
        type: tool.schema
          .enum(["tool", "skill", "command", "agent", "knowledge", "script", "any"])
          .optional()
          .describe("Optional asset type filter. Defaults to 'any'."),
        limit: tool.schema.number().optional().describe("Maximum number of registry hits to return. Defaults to 20."),
        usage: tool.schema
          .enum(["none", "both", "item", "guide"])
          .optional()
          .describe("Usage metadata mode. Defaults to the CLI behavior when omitted."),
      },
      async execute({ query, type, limit, usage }) {
        return runCli(createSearchArgs({ query, type, limit, usage, defaultSource: "registry" }))
      },
    }),
    akm_show: tool({
      description: "Show a stash asset by ref. For knowledge assets, use view_mode to retrieve specific content (toc, section, lines, frontmatter).",
      args: {
        ref: tool.schema.string().describe("Asset reference returned by akm_search."),
        view_mode: tool.schema
          .enum(["full", "toc", "frontmatter", "section", "lines"])
          .optional()
          .describe("View mode for knowledge assets. Defaults to 'full'. Ignored for other types."),
        heading: tool.schema.string().optional()
          .describe("Section heading to extract (required when view_mode is 'section')."),
        start_line: tool.schema.number().optional()
          .describe("Start line number, 1-based (for view_mode 'lines')."),
        end_line: tool.schema.number().optional()
          .describe("End line number, 1-based inclusive (for view_mode 'lines')."),
      },
      async execute({ ref, view_mode, heading, start_line, end_line }) {
        const args = ["show", ref]
        if (view_mode) args.push("--view", view_mode)
        if (heading) args.push("--heading", heading)
        if (start_line != null) args.push("--start", String(start_line))
        if (end_line != null) args.push("--end", String(end_line))
        return runCli(args)
      },
    }),
    akm_index: tool({
      description: "Build or rebuild the Agentikit stash index. Scans stash directories, generates missing .stash.json metadata, and builds a semantic search index.",
      args: {},
      async execute() {
        return runCli(["index"])
      },
    }),
    akm_add: tool({
      description: "Install a kit from npm, GitHub, another git host, or a local directory. Installed kits become searchable alongside local assets.",
      args: {
        package_ref: tool.schema.string().describe("Package reference such as npm:@scope/kit, github:<owner>/<repo>, git+https://host/repo, or ./local/kit."),
      },
      async execute({ package_ref }) {
        return runCli(["add", package_ref])
      },
    }),
    akm_list: tool({
      description: "List all kits installed from the registry.",
      args: {},
      async execute() {
        return runCli(["list"])
      },
    }),
    akm_remove: tool({
      description: "Remove an installed registry kit by id or ref and reindex the stash.",
      args: {
        package_ref: tool.schema.string().describe("Installed kit id or ref, such as npm:@scope/kit or owner/repo."),
      },
      async execute({ package_ref }) {
        return runCli(["remove", package_ref])
      },
    }),
    akm_update: tool({
      description: "Update one installed kit or all installed kits to the latest available version.",
      args: {
        package_ref: tool.schema.string().optional().describe("Installed kit id or ref to update."),
        all: tool.schema.boolean().optional().describe("Update all installed kits."),
        force: tool.schema.boolean().optional().describe("Force a fresh download even if the version is unchanged."),
      },
      async execute({ package_ref, all, force }) {
        const args = ["update"]
        if (all) {
          args.push("--all")
        } else if (package_ref?.trim()) {
          args.push(package_ref.trim())
        } else {
          return JSON.stringify({ ok: false, error: "Provide 'package_ref' or set 'all' to true." })
        }
        if (force) args.push("--force")
        return runCli(args)
      },
    }),
    akm_clone: tool({
      description: "Clone an asset from any source into the working stash or a custom destination for editing.",
      args: {
        ref: tool.schema.string().describe("Asset ref to clone, including optional origin such as npm:@scope/pkg//tool:deploy.sh."),
        name: tool.schema.string().optional().describe("Optional new asset name."),
        dest: tool.schema.string().optional().describe("Optional destination directory. The type subdirectory is appended automatically by akm."),
        force: tool.schema.boolean().optional().describe("Overwrite the destination if it already exists."),
      },
      async execute({ ref, name, dest, force }) {
        const args = ["clone", ref]
        if (name) args.push("--name", name)
        if (dest) args.push("--dest", dest)
        if (force) args.push("--force")
        return runCli(args)
      },
    }),
    akm_agent: tool({
      description: "Dispatch a stash agent by ref into a child OpenCode session, applying the agent prompt and metadata from akm_show.",
      args: {
        ref: tool.schema.string().optional().describe("Agent ref from akm_search (e.g. agent:my-agent.md)."),
        query: tool.schema.string().optional().describe("If ref is omitted, resolve best matching stash agent for this query."),
        task_prompt: tool.schema.string().describe("Task prompt sent to the dispatched OpenCode agent."),
        dispatch_agent: tool.schema.string().optional().describe("OpenCode agent to run the task with. Defaults to 'general'."),
        as_subtask: tool.schema.boolean().optional().describe("Run in child session with parent context. Defaults to true."),
      },
      async execute({ ref, query, task_prompt, dispatch_agent, as_subtask }, context) {
        const resolved = resolveRefInput({ ref, query }, "agent")
        if (!resolved.ok) return JSON.stringify(resolved)

        const shownRaw = runCli(["show", resolved.ref])
        const shown = parseCliJson<ShowAgentResponse | { type: string }>(shownRaw)
        if (isCliError(shown)) {
          return JSON.stringify(shown)
        }

        if (!isShowAgentResponse(shown)) {
          return JSON.stringify({
            ok: false,
            error: `Ref ${ref} is not an agent payload from akm_show.`,
          })
        }

        if (!shown.prompt || !shown.prompt.trim()) {
          return JSON.stringify({
            ok: false,
            error: `Agent ${shown.name} is missing prompt content.`,
          })
        }

        const useSubtask = as_subtask ?? true
        const targetAgent = dispatch_agent ?? "general"
        const model = parseModelHint(shown.modelHint)
        const tools = parseToolPolicy(shown.toolPolicy)

        const targetSession = await ensureTargetSessionID({
          useSubtask,
          context: { sessionID: context.sessionID, directory: context.directory },
          title: `agentikit:${shown.name}`,
          client: client as unknown as PluginClient,
        })
        if (!targetSession.ok) return JSON.stringify(targetSession)

        const promptBody: {
          agent: string
          system: string
          parts: Array<{ type: "text"; text: string }>
          model?: { providerID: string; modelID: string }
          tools?: Record<string, boolean>
        } = {
          agent: targetAgent,
          system: shown.prompt,
          parts: [{ type: "text", text: task_prompt }],
        }
        if (model) promptBody.model = model
        if (tools) promptBody.tools = tools

        const promptResponse = await client.session.prompt({
          query: { directory: context.directory },
          path: { id: targetSession.sessionID },
          body: promptBody,
        })

        if (promptResponse.error || !promptResponse.data) {
          const reason = promptResponse.error ? JSON.stringify(promptResponse.error) : "empty response"
          return JSON.stringify({
            ok: false,
            error: `Failed to dispatch prompt for ${resolved.ref}: ${reason}`,
          })
        }

        return JSON.stringify({
          ok: true,
          ref: resolved.ref,
          stashAgent: shown.name,
          dispatchAgent: targetAgent,
          usedSubtask: useSubtask,
          sessionID: targetSession.sessionID,
          model,
          tools,
          text: extractText(promptResponse.data.parts),
        })
      },
    }),
    akm_cmd: tool({
      description: "Execute a stash command template through the OpenCode SDK in the current or child session.",
      args: {
        ref: tool.schema.string().optional().describe("Command ref from akm_search (e.g. command:review.md)."),
        query: tool.schema.string().optional().describe("If ref is omitted, resolve best matching stash command for this query."),
        arguments: tool.schema.string().optional().describe("Command arguments used for $ARGUMENTS and positional placeholders ($1, $2, ...)."),
        dispatch_agent: tool.schema.string().optional().describe("OpenCode agent to run the rendered command. Defaults to current agent."),
        as_subtask: tool.schema.boolean().optional().describe("Run in child session with parent context. Defaults to false."),
      },
      async execute({ ref, query, arguments: commandArguments, dispatch_agent, as_subtask }, context) {
        const resolved = resolveRefInput({ ref, query }, "command")
        if (!resolved.ok) return JSON.stringify(resolved)

        const shownRaw = runCli(["show", resolved.ref])
        const shown = parseCliJson<ShowCommandResponse | { type: string }>(shownRaw)
        if (isCliError(shown)) return JSON.stringify(shown)
        if (!isShowCommandResponse(shown)) {
          return JSON.stringify({ ok: false, error: `Ref ${resolved.ref} is not a command payload from akm_show.` })
        }

        const template = shown.template?.trim()
        if (!template) {
          return JSON.stringify({ ok: false, error: `Command ${shown.name} is missing template content.` })
        }

        const argsText = commandArguments ?? ""
        const rendered = renderCommandTemplate(template, argsText)
        const useSubtask = as_subtask ?? false
        const targetAgent = dispatch_agent ?? context.agent

        const targetSession = await ensureTargetSessionID({
          useSubtask,
          context: { sessionID: context.sessionID, directory: context.directory },
          title: `agentikit:cmd:${shown.name}`,
          client: client as unknown as PluginClient,
        })
        if (!targetSession.ok) return JSON.stringify(targetSession)

        const promptResponse = await client.session.prompt({
          query: { directory: context.directory },
          path: { id: targetSession.sessionID },
          body: {
            agent: targetAgent,
            parts: [{ type: "text", text: rendered }],
          },
        })

        if (promptResponse.error || !promptResponse.data) {
          const reason = promptResponse.error ? JSON.stringify(promptResponse.error) : "empty response"
          return JSON.stringify({
            ok: false,
            error: `Failed to execute command ${resolved.ref}: ${reason}`,
          })
        }

        return JSON.stringify({
          ok: true,
          ref: resolved.ref,
          stashCommand: shown.name,
          dispatchAgent: targetAgent,
          usedSubtask: useSubtask,
          sessionID: targetSession.sessionID,
          arguments: argsText,
          renderedTemplate: rendered,
          text: extractText(promptResponse.data.parts),
        })
      },
    }),
    akm_config: tool({
      description: "View or update Agentikit configuration settings.",
      args: {
        action: tool.schema.enum(["get", "set", "list"]).describe("Config action: 'get' a key, 'set' a key/value, or 'list' all settings."),
        key: tool.schema.string().optional().describe("Config key (required for get/set)."),
        value: tool.schema.string().optional().describe("Config value (required for set)."),
      },
      async execute({ action, key, value }) {
        const args = ["config", action]
        if (key) args.push(key)
        if (value) args.push(value)
        return runCli(args)
      },
    }),
    akm_run: tool({
      description: "Execute a stash tool or script by ref. Resolves via search, fetches metadata via show, and runs the runCmd.",
      args: {
        ref: tool.schema.string().optional().describe("Tool ref from akm_search (e.g. tool:deploy.sh)."),
        query: tool.schema.string().optional().describe("If ref is omitted, resolve best matching stash tool for this query."),
        args: tool.schema.string().optional().describe("Arguments to append to the runCmd."),
      },
      async execute({ ref, query, args: runArgs }) {
        const resolved = resolveRefInput({ ref, query }, "tool")
        if (!resolved.ok) return JSON.stringify(resolved)

        const shownRaw = runCli(["show", resolved.ref])
        const shown = parseCliJson<ShowToolResponse | { type: string }>(shownRaw)
        if (isCliError(shown)) return JSON.stringify(shown)

        if (!isShowToolResponse(shown)) {
          return JSON.stringify({
            ok: false,
            error: `Ref ${resolved.ref} is not a tool payload from akm_show.`,
          })
        }

        if (!shown.runCmd || !shown.runCmd.trim()) {
          return JSON.stringify({
            ok: false,
            error: `Tool ${shown.name} is missing runCmd.`,
          })
        }

        let cmd = shown.runCmd
        if (runArgs && runArgs.trim()) {
          cmd = `${cmd} ${runArgs.trim()}`
        }

        try {
          const output = execSync(cmd, {
            encoding: "utf8",
            timeout: 120_000,
          })
          return JSON.stringify({
            ok: true,
            ref: resolved.ref,
            tool: shown.name,
            runCmd: cmd,
            output,
          })
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          return JSON.stringify({
            ok: false,
            error: `Failed to execute runCmd for ${shown.name}: ${message}`,
          })
        }
      },
    }),
    akm_submit: tool({
      description: "Submit a kit to the Agentikit registry.",
      args: {
        dry_run: tool.schema.boolean().optional().describe("If true, perform a dry run without actually submitting."),
      },
      async execute({ dry_run }) {
        const args = ["submit"]
        if (dry_run) args.push("--dry-run")
        return runCli(args)
      },
    }),
  },
})
