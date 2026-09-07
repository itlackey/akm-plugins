function positiveSafeInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`)
  }
  return value
}

export function supportsFragmentLeadContext(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  return major > 0 || minor > 9 || (minor === 9 && patch >= 15)
}

/** Map the public OpenCode schema onto akmShowUnified's character-budget API. */
export function normalizeFragmentShowInput(
  input: Record<string, unknown>,
  loadedAkmApiVersion: string,
): Record<string, unknown> {
  const {
    context,
    max_tokens: rawMaxTokens,
    max_chars: rawMaxChars,
    ...showInput
  } = input
  const maxTokens = positiveSafeInteger(rawMaxTokens, "max_tokens")
  const maxChars = positiveSafeInteger(rawMaxChars, "max_chars")
  if (maxTokens !== undefined && maxChars !== undefined) {
    throw new Error("max_tokens and max_chars are mutually exclusive")
  }
  const contextMode = context
  if (contextMode === "lead" && !supportsFragmentLeadContext(loadedAkmApiVersion)) {
    throw new Error(
      `context='lead' requires akm-cli >=0.9.15; this plugin bundles ${loadedAkmApiVersion}. `
      + "Install the plugin release whose exact akm-cli pin is 0.9.15 or newer.",
    )
  }
  const maxContextChars = maxChars ?? (maxTokens !== undefined ? maxTokens * 4 : undefined)
  if (maxContextChars !== undefined && !Number.isSafeInteger(maxContextChars)) {
    throw new Error("fragment context budget is too large")
  }
  if (maxContextChars !== undefined && contextMode !== "lead") {
    throw new Error("max_tokens and max_chars require context='lead'")
  }
  return {
    ...showInput,
    ...(contextMode !== undefined ? { contextMode } : {}),
    ...(maxContextChars !== undefined ? { maxContextChars } : {}),
  }
}
