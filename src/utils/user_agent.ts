function getMacroVersion(): string {
  const macroGlobal = (
    globalThis as unknown as { MACRO?: { VERSION?: string } }
  ).MACRO
  return macroGlobal?.VERSION ?? '0.0.1'
}

export function getClaudeCodeUserAgent(): string {
  return `claude-code/${getMacroVersion()}`
}
