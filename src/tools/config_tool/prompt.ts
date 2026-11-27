export const CONFIG_TOOL_DESCRIPTION =
  'Gets or sets Copilot CLI configuration settings (`~/.copilot/settings.json` and `~/.copilot.json`).'

export const CONFIG_TOOL_PROMPT = `Reads or updates Copilot CLI configuration settings.
- Omit \`value\` to read the current effective value of \`setting\`.
- Provide \`value\` to update a supported user setting (e.g. model, theme, verbose, effortLevel, alwaysThinkingEnabled, defaultShell, language, outputStyle, permissions.defaultMode).`
