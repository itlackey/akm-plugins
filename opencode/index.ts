import { type Plugin, tool } from "@opencode-ai/plugin"
import { execFileSync, execSync } from "node:child_process"
import path from "node:path"

let resolvedAkmCommand = "akm"
let attemptedAutoInstall = false

type LogLevel = "debug" | "info" | "warn" | "error"

type LogCapableClient = {
  app: {
    log: (options: {
      query?: { directory?: string }
      body: {
        service: string
        level: LogLevel
        message: string
        extra?: Record<string, unknown>
      }
    }) => Promise<unknown>
  }
}

type CliLogMeta = {
  toolName: string
  directory?: string
  sessionID?: string
}

function formatCliError(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
    return "The 'akm' CLI was not found on PATH. Install it first from https://github.com/itlackey/agentikit."
  }
  return error instanceof Error ? error.message : String(error)
}

function toLogString(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (value instanceof Buffer) return value.toString("utf8")
  return undefined
}

function getExecStatus(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("status" in error)) return null
  const status = (error as { status?: unknown }).status
  return typeof status === "number" ? status : null
}

async function writePluginLog(client: LogCapableClient, level: LogLevel, message: string, extra: Record<string, unknown>) {
  try {
    await client.app.log({
      query: typeof extra.directory === "string" ? { directory: extra.directory } : undefined,
      body: {
        service: "akm-opencode",
        level,
        message,
        extra,
      },
    })
  } catch {
    // Avoid breaking the TUI if logging itself fails.
  }
}

function getCommandStatus(command: string): "ok" | "missing" | "error" {
  try {
    execFileSync(command, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
    })
    return "ok"
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
      return "missing"
    }
    return "error"
  }
}

function resolveAkmCommand(): string | CliError {
  const currentStatus = getCommandStatus(resolvedAkmCommand)
  if (currentStatus === "ok" || currentStatus === "error") return resolvedAkmCommand

  if (attemptedAutoInstall) {
    return { ok: false, error: "The 'akm' CLI was not found on PATH and automatic installation was unsuccessful." }
  }
  attemptedAutoInstall = true

  try {
    execFileSync("bun", ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
    })
  } catch {
    return {
      ok: false,
      error: "The 'akm' CLI was not found on PATH, and Bun is not available for automatic installation. Install akm from https://github.com/itlackey/agentikit.",
    }
  }

  try {
    execFileSync("bun", ["install", "-g", "akm-cli"], {
      encoding: "utf8",
      timeout: 120_000,
      stdio: "pipe",
    })

    const globalBin = execFileSync("bun", ["pm", "bin", "-g"], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim()

    const candidate = path.join(globalBin, process.platform === "win32" ? "akm.exe" : "akm")
    if (getCommandStatus(candidate) === "ok") {
      resolvedAkmCommand = candidate
      return resolvedAkmCommand
    }

    if (getCommandStatus("akm") === "ok") {
      resolvedAkmCommand = "akm"
      return resolvedAkmCommand
    }

    return {
      ok: false,
      error: "Installed 'akm-cli' via Bun, but the 'akm' executable could not be resolved. Check your Bun global bin directory and PATH.",
    }
  } catch (error: unknown) {
    return {
      ok: false,
      error: `Failed to auto-install 'akm-cli' via Bun: ${formatCliError(error)}`,
    }
  }
}

async function runCli(client: LogCapableClient, args: string[], meta: CliLogMeta): Promise<string> {
  const command = resolveAkmCommand()
  if (typeof command !== "string") {
    await writePluginLog(client, "error", "AKM command resolution failed", {
      subsystem: "akm",
      toolName: meta.toolName,
      sessionID: meta.sessionID,
      directory: meta.directory,
      command: resolvedAkmCommand,
      args,
      exitCode: null,
      stdout: "",
      stderr: command.error,
    })
    return JSON.stringify(command)
  }

  const fullArgs = [...args, "--format", "json"]

  try {
    const stdout = execFileSync(command, fullArgs, {
      encoding: "utf8",
      timeout: 60_000,
    })
    await writePluginLog(client, "info", "AKM command completed", {
      subsystem: "akm",
      toolName: meta.toolName,
      sessionID: meta.sessionID,
      directory: meta.directory,
      command,
      args: fullArgs,
      exitCode: 0,
      stdout,
      stderr: "",
    })
    return stdout
  } catch (error: unknown) {
    const message = formatCliError(error)
    await writePluginLog(client, "error", "AKM command failed", {
      subsystem: "akm",
      toolName: meta.toolName,
      sessionID: meta.sessionID,
      directory: meta.directory,
      command,
      args: fullArgs,
      exitCode: getExecStatus(error),
      stdout: toLogString((error as { stdout?: unknown }).stdout) ?? "",
      stderr: toLogString((error as { stderr?: unknown }).stderr) ?? message,
    })
    return JSON.stringify({ ok: false, error: message })
  }
}

type CliError = { ok: false; error: string }
type AssetType = "skill" | "command" | "agent" | "knowledge" | "script"

type ShowAgentResponse = {
  type: "agent"
  name: string
  path: string
  description?: string
  prompt?: string
  toolPolicy?: unknown
  modelHint?: unknown
  editable?: boolean
  origin?: string | null
  action?: string
  editHint?: string
}

type ShowCommandResponse = {
  type: "command"
  name: string
  path: string
  description?: string
  template?: string
  editable?: boolean
  agent?: string
  origin?: string | null
  action?: string
  parameters?: string[]
  editHint?: string
}

type ShowToolResponse = {
  type: "tool" | "script"
  name: string
  path?: string
  description?: string
  run?: string
  setup?: string
  cwd?: string
  editable?: boolean
  origin?: string | null
  action?: string
  editHint?: string
}

type SearchHit = {
  type: AssetType | "registry" | "registry-asset"
  ref?: string
  id?: string
  installRef?: string
  editable?: boolean
  name?: string
  description?: string
  score?: number
  whyMatched?: string[]
  run?: string
  origin?: string | null
  size?: string
  action?: string
  editHint?: string
  curated?: boolean
}

type SearchResponse = {
  hits?: SearchHit[]
  source?: "local" | "registry" | "both"
  stashDir?: string
  timing?: { totalMs?: number; rankMs?: number; embedMs?: number }
  warnings?: string[]
  tip?: string
}

function isShowToolResponse(value: unknown): value is ShowToolResponse {
  return !!value
    && typeof value === "object"
    && ((value as { type?: unknown }).type === "tool" || (value as { type?: unknown }).type === "script")
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
      error: "akm CLI returned non-JSON output",
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
  const result: Record<string, boolean> = {}

  const assign = (key: string, value: unknown) => {
    const normalizedKey = key.trim().toLowerCase()
    if (!normalizedKey) return
    if (typeof value === "boolean") {
      result[normalizedKey] = value
      return
    }
    if (typeof value === "string") {
      if (value === "allow") result[normalizedKey] = true
      if (value === "deny") result[normalizedKey] = false
    }
  }

  if (typeof toolPolicy === "string") {
    assign(toolPolicy, true)
    return Object.keys(result).length > 0 ? result : undefined
  }

  if (Array.isArray(toolPolicy)) {
    for (const item of toolPolicy) {
      if (typeof item === "string") assign(item, true)
    }
    return Object.keys(result).length > 0 ? result : undefined
  }

  if (!toolPolicy || typeof toolPolicy !== "object") return undefined

  for (const [key, value] of Object.entries(toolPolicy as Record<string, unknown>)) {
    assign(key, value)
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

async function resolveRefInput(
  client: LogCapableClient,
  input: { ref?: string; query?: string },
  type: AssetType,
  meta: CliLogMeta,
): Promise<{ ok: true; ref: string } | CliError> {
  if (input.ref && input.ref.trim()) {
    return { ok: true, ref: input.ref.trim() }
  }

  const query = input.query?.trim()
  if (!query) {
    return { ok: false, error: "Provide either 'ref' or 'query'." }
  }

  const raw = await runCli(client, ["search", query, "--type", type, "--limit", "1", "--detail", "normal", "--source", "local"], meta)
  const parsed = parseCliJson<SearchResponse>(raw)
  if (isCliError(parsed)) return parsed

  const ref = parsed.hits?.[0]?.ref
  if (!ref) {
    return { ok: false, error: `No ${type} match found for query '${query}'.` }
  }

  return { ok: true, ref }
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
  args.push("--detail", "normal")
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
      description: "Search your local stash or the akm registry for scripts, skills, commands, agents, and knowledge. Use source='registry' or akm_registry_search for installable community kits.",
      args: {
        query: tool.schema.string().describe("Case-insensitive substring search."),
        type: tool.schema
          .enum(["skill", "command", "agent", "knowledge", "script", "any"])
          .optional()
          .describe("Optional type filter. Defaults to 'any'."),
        limit: tool.schema.number().optional().describe("Maximum number of hits to return. Defaults to 20."),
        source: tool.schema
          .enum(["local", "registry", "both"])
          .optional()
          .describe("Search source. 'local' searches stash dirs, 'registry' searches npm/GitHub, 'both' searches all. Defaults to 'local'."),
      },
      async execute({ query, type, limit, source }) {
        return runCli(client as unknown as LogCapableClient, createSearchArgs({ query, type, limit, source }), { toolName: "akm_search" })
      },
    }),
    akm_registry_search: tool({
      description: "Search configured akm registries only. Use this when you want installable kits without mixing in local stash results.",
      args: {
        query: tool.schema.string().describe("Search query for installable registry kits."),
        type: tool.schema
          .enum(["skill", "command", "agent", "knowledge", "script", "any"])
          .optional()
          .describe("Optional asset type filter. Defaults to 'any'."),
        limit: tool.schema.number().optional().describe("Maximum number of registry hits to return. Defaults to 20."),
        assets: tool.schema.boolean().optional().describe("Include asset-level results from registry index v2 payloads."),
      },
      async execute({ query, type, limit, assets }) {
        const args = ["registry", "search", query]
        if (limit) args.push("--limit", String(limit))
        const assetTypeFilter = type && type !== "any" ? type : undefined
        if (assets || assetTypeFilter) args.push("--assets")

        const raw = await runCli(client as unknown as LogCapableClient, args, { toolName: "akm_registry_search" })
        if (!assetTypeFilter) return raw

        const parsed = parseCliJson<{
          hits?: SearchHit[]
          assetHits?: Array<SearchHit & { assetType?: AssetType }>
          warnings?: string[]
          query?: string
        }>(raw)
        if (isCliError(parsed)) return JSON.stringify(parsed)

        return JSON.stringify({
          ...parsed,
          hits: [],
          assetHits: (parsed.assetHits ?? []).filter((hit) => hit.assetType === assetTypeFilter),
        })
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
        if (view_mode) {
          args.push(view_mode)
          if (view_mode === "section" && heading) args.push(heading)
          if (view_mode === "lines") {
            if (start_line != null) args.push(String(start_line))
            if (end_line != null) args.push(String(end_line))
          }
        }
        return runCli(client as unknown as LogCapableClient, args, { toolName: "akm_show" })
      },
    }),
    akm_index: tool({
      description: "Build or rebuild the akm stash index. Scans stash directories, generates missing .stash.json metadata, and builds a semantic search index.",
      args: {},
      async execute() {
        return runCli(client as unknown as LogCapableClient, ["index"], { toolName: "akm_index" })
      },
    }),
    akm_add: tool({
      description: "Install a kit from npm, GitHub, another git host, or a local directory. Installed kits become searchable alongside local assets.",
      args: {
        package_ref: tool.schema.string().describe("Package reference such as npm:@scope/kit, github:<owner>/<repo>, git+https://host/repo, or ./local/kit."),
      },
      async execute({ package_ref }) {
        return runCli(client as unknown as LogCapableClient, ["add", package_ref], { toolName: "akm_add" })
      },
    }),
    akm_list: tool({
      description: "List all kits installed from the registry.",
      args: {},
      async execute() {
        return runCli(client as unknown as LogCapableClient, ["list"], { toolName: "akm_list" })
      },
    }),
    akm_remove: tool({
      description: "Remove an installed registry kit by id or ref and reindex the stash.",
      args: {
        package_ref: tool.schema.string().describe("Installed kit id or ref, such as npm:@scope/kit or owner/repo."),
      },
      async execute({ package_ref }) {
        return runCli(client as unknown as LogCapableClient, ["remove", package_ref], { toolName: "akm_remove" })
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
        const packageRef = package_ref?.trim()
        if (all) {
          args.push("--all")
        } else if (packageRef) {
          args.push(packageRef)
        } else {
          return JSON.stringify({ ok: false, error: "Provide 'package_ref' or set 'all' to true." })
        }
        if (force) args.push("--force")
        return runCli(client as unknown as LogCapableClient, args, { toolName: "akm_update" })
      },
    }),
    akm_clone: tool({
      description: "Clone an asset from any source into the working stash or a custom destination for editing.",
      args: {
        ref: tool.schema.string().describe("Asset ref to clone, including optional origin such as npm:@scope/pkg//script:deploy.sh."),
        name: tool.schema.string().optional().describe("Optional new asset name."),
        dest: tool.schema.string().optional().describe("Optional destination directory. The type subdirectory is appended automatically by akm."),
        force: tool.schema.boolean().optional().describe("Overwrite the destination if it already exists."),
      },
      async execute({ ref, name, dest, force }) {
        const args = ["clone", ref]
        if (name) args.push("--name", name)
        if (dest) args.push("--dest", dest)
        if (force) args.push("--force")
        return runCli(client as unknown as LogCapableClient, args, { toolName: "akm_clone" })
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
        const logMeta = {
          toolName: "akm_agent",
          directory: context.directory,
          sessionID: context.sessionID,
        }
        const resolved = await resolveRefInput(client as unknown as LogCapableClient, { ref, query }, "agent", logMeta)
        if (!resolved.ok) return JSON.stringify(resolved)

        const shownRaw = await runCli(client as unknown as LogCapableClient, ["show", resolved.ref], logMeta)
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
          title: `akm:${shown.name}`,
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
        const logMeta = {
          toolName: "akm_cmd",
          directory: context.directory,
          sessionID: context.sessionID,
        }
        const resolved = await resolveRefInput(client as unknown as LogCapableClient, { ref, query }, "command", logMeta)
        if (!resolved.ok) return JSON.stringify(resolved)

        const shownRaw = await runCli(client as unknown as LogCapableClient, ["show", resolved.ref], logMeta)
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
          title: `akm:cmd:${shown.name}`,
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
      description: "View or update akm configuration settings.",
      args: {
        action: tool.schema.enum(["get", "set", "list", "unset", "path"]).describe("Config action: get, set, list, unset, or path."),
        key: tool.schema.string().optional().describe("Config key (required for get/set)."),
        value: tool.schema.string().optional().describe("Config value (required for set)."),
        all: tool.schema.boolean().optional().describe("When action is 'path', include config, stash, cache, and index paths."),
      },
      async execute({ action, key, value, all }) {
        const args = ["config", action]
        if (key) args.push(key)
        if (value) args.push(value)
        if (action === "path" && all) args.push("--all")
        return runCli(client as unknown as LogCapableClient, args, { toolName: "akm_config" })
      },
    }),
    akm_run: tool({
      description: "Execute a stash script by ref. Resolves via search, fetches metadata via show, and runs the run command.",
      args: {
        ref: tool.schema.string().optional().describe("Script ref from akm_search (e.g. script:deploy.sh)."),
        query: tool.schema.string().optional().describe("If ref is omitted, resolve best matching stash script for this query."),
        args: tool.schema.string().optional().describe("Arguments to append to the run command."),
      },
      async execute({ ref, query, args: runArgs }) {
        const resolved = await resolveRefInput(client as unknown as LogCapableClient, { ref, query }, "script", { toolName: "akm_run" })
        if (!resolved.ok) return JSON.stringify(resolved)

        const shownRaw = await runCli(client as unknown as LogCapableClient, ["show", resolved.ref], { toolName: "akm_run" })
        const shown = parseCliJson<ShowToolResponse | { type: string }>(shownRaw)
        if (isCliError(shown)) return JSON.stringify(shown)

        if (!isShowToolResponse(shown)) {
          return JSON.stringify({
            ok: false,
            error: `Ref ${resolved.ref} is not a script payload from akm_show.`,
          })
        }

        if (!shown.run || !shown.run.trim()) {
          return JSON.stringify({
            ok: false,
            error: `Script ${shown.name} is missing run command.`,
          })
        }

        let cmd = shown.run
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
            script: shown.name,
            run: cmd,
            output,
          })
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          return JSON.stringify({
            ok: false,
            error: `Failed to execute run command for ${shown.name}: ${message}`,
          })
        }
      },
    }),
    akm_sources: tool({
      description: "List all resolved stash search paths and their status.",
      args: {},
      async execute() {
        return runCli(client as unknown as LogCapableClient, ["sources"], { toolName: "akm_sources" })
      },
    }),
    akm_upgrade: tool({
      description: "Check for or install akm CLI updates.",
      args: {
        check: tool.schema.boolean().optional().describe("Only check for updates without installing."),
        force: tool.schema.boolean().optional().describe("Force upgrade even if already on latest version."),
      },
      async execute({ check, force }) {
        const args = ["upgrade"]
        if (check) args.push("--check")
        if (force) args.push("--force")
        return runCli(client as unknown as LogCapableClient, args, { toolName: "akm_upgrade" })
      },
    }),
  },
})
