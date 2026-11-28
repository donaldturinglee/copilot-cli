/**
 * `${VAR}` and `${VAR:-default}` environment variable expansion for `.mcp.json`
 * and MCP server configurations.
 */

import type { McpServerConfig } from './types.js'

const ENV_VAR_PATTERN = /\$\{([^}]+)\}/g

/**
 * Expands `${VAR}` and `${VAR:-default}` placeholders in `value` against `env`.
 * Unresolved variables without a fallback are left intact and recorded in `missingVars`.
 */
export function expandEnvVarsInString(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
): { expanded: string; missingVars: string[] } {
  const missingVars: string[] = []
  const expanded = value.replace(
    ENV_VAR_PATTERN,
    (fullMatch: string, expr: string) => {
      const defaultIdx = expr.indexOf(':-')
      const varName =
        defaultIdx === -1 ? expr.trim() : expr.slice(0, defaultIdx).trim()
      const defaultValue =
        defaultIdx === -1 ? undefined : expr.slice(defaultIdx + 2)

      if (!varName) {
        return fullMatch
      }
      const envValue = env[varName]
      if (envValue !== undefined) {
        return envValue
      }
      if (defaultValue !== undefined) {
        return defaultValue
      }
      if (!missingVars.includes(varName)) {
        missingVars.push(varName)
      }
      return fullMatch
    },
  )
  return { expanded, missingVars }
}

function recordMissing(target: string[], additions: readonly string[]): void {
  for (const name of additions) {
    if (!target.includes(name)) {
      target.push(name)
    }
  }
}

function expandStringMap(
  record: Record<string, string> | undefined,
  missingVars: string[],
  env: NodeJS.ProcessEnv,
): Record<string, string> | undefined {
  if (!record) {
    return undefined
  }
  const out: Record<string, string> = {}
  for (const [key, val] of Object.entries(record)) {
    const res = expandEnvVarsInString(val, env)
    out[key] = res.expanded
    recordMissing(missingVars, res.missingVars)
  }
  return out
}

/**
 * Expands `${VAR}` / `${VAR:-default}` across `command`, `args`, `env`, `url`,
 * and static `headers` of an `McpServerConfig`. Note that `headersHelper` is
 * intentionally left unexpanded prior to shell execution.
 */
export function expandEnvVarsInConfig<ConfigType extends McpServerConfig>(
  config: ConfigType,
  env: NodeJS.ProcessEnv = process.env,
): { expanded: ConfigType; missingVars: string[] } {
  const missingVars: string[] = []

  if (!config.type || config.type === 'stdio') {
    const cmdRes = expandEnvVarsInString(config.command, env)
    recordMissing(missingVars, cmdRes.missingVars)

    const expandedArgs = config.args?.map(arg => {
      const argRes = expandEnvVarsInString(arg, env)
      recordMissing(missingVars, argRes.missingVars)
      return argRes.expanded
    })

    const expandedEnv = expandStringMap(config.env, missingVars, env)

    return {
      expanded: {
        ...config,
        command: cmdRes.expanded,
        ...(expandedArgs !== undefined ? { args: expandedArgs } : {}),
        ...(expandedEnv !== undefined ? { env: expandedEnv } : {}),
      } as ConfigType,
      missingVars,
    }
  }

  if (
    config.type === 'sse' ||
    config.type === 'http' ||
    config.type === 'ws'
  ) {
    const urlRes = expandEnvVarsInString(config.url, env)
    recordMissing(missingVars, urlRes.missingVars)
    const expandedHeaders = expandStringMap(config.headers, missingVars, env)
    return {
      expanded: {
        ...config,
        url: urlRes.expanded,
        ...(expandedHeaders !== undefined ? { headers: expandedHeaders } : {}),
      } as ConfigType,
      missingVars,
    }
  }

  if (
    config.type === 'sse-ide' ||
    config.type === 'ws-ide' ||
    config.type === 'claudeai-proxy'
  ) {
    const urlRes = expandEnvVarsInString(config.url, env)
    recordMissing(missingVars, urlRes.missingVars)
    return {
      expanded: {
        ...config,
        url: urlRes.expanded,
      } as ConfigType,
      missingVars,
    }
  }

  return { expanded: { ...config }, missingVars }
}
