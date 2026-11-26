import { z } from 'zod/v4'
import type { PermissionRuleValue } from '../../types/permissions.js'
import { lazySchema } from '../lazy_schema.js'
import {
  getCustomValidation,
  isBashPrefixTool,
  isFilePatternTool,
} from './tool_validation_config.js'

const LEGACY_TOOL_ALIASES: Record<string, string> = {
  Task: 'Agent',
  KillShell: 'TaskStop',
  AgentOutputTool: 'TaskOutput',
  BashOutputTool: 'TaskOutput',
}

export type PermissionRuleValidationResult = {
  valid: boolean
  error?: string
  suggestion?: string
  examples?: string[]
}

export function mcpInfoFromString(
  toolName: string,
): { serverName: string; toolName?: string } | null {
  if (!toolName.startsWith('mcp__')) {
    return null
  }
  const parts = toolName.split('__')
  const serverName = parts[1]
  if (!serverName) {
    return null
  }
  const mcpToolName = parts.length >= 3 ? parts.slice(2).join('__') : undefined
  return { serverName, toolName: mcpToolName || undefined }
}

function unescapeRuleContent(raw: string): string {
  return raw
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\')
}

function isEscaped(input: string, index: number): boolean {
  let backslashCount = 0
  let cursor = index - 1
  while (cursor >= 0 && input[cursor] === '\\') {
    backslashCount++
    cursor--
  }
  return backslashCount % 2 === 1
}

export function permissionRuleValueFromString(
  ruleString: string,
): PermissionRuleValue {
  let openIndex = -1
  for (let i = 0; i < ruleString.length; i++) {
    if (ruleString[i] === '(' && !isEscaped(ruleString, i)) {
      openIndex = i
      break
    }
  }

  if (openIndex === -1) {
    const rawToolName = ruleString.trim()
    return {
      toolName: LEGACY_TOOL_ALIASES[rawToolName] ?? rawToolName,
    }
  }

  const rawToolName = ruleString.slice(0, openIndex).trim()
  const toolName = LEGACY_TOOL_ALIASES[rawToolName] ?? rawToolName
  const closeIndex = ruleString.lastIndexOf(')')
  if (closeIndex <= openIndex) {
    return { toolName }
  }

  const rawContent = ruleString.slice(openIndex + 1, closeIndex)
  if (rawContent === '' || rawContent === '*') {
    return { toolName }
  }

  return {
    toolName,
    ruleContent: unescapeRuleContent(rawContent),
  }
}

export function validatePermissionRule(
  rule: string,
): PermissionRuleValidationResult {
  if (!rule || rule.trim() === '') {
    return {
      valid: false,
      error: 'Permission rule cannot be empty',
    }
  }

  let depth = 0
  let firstOpen = -1
  let hasEmptyParens = false
  for (let i = 0; i < rule.length; i++) {
    const char = rule[i]
    if (char === '(' && !isEscaped(rule, i)) {
      if (firstOpen === -1) firstOpen = i
      depth++
      if (rule[i + 1] === ')' && !isEscaped(rule, i + 1)) {
        hasEmptyParens = true
      }
    } else if (char === ')' && !isEscaped(rule, i)) {
      depth--
      if (depth < 0) {
        return {
          valid: false,
          error: 'Unmatched closing parenthesis in permission rule',
          suggestion: 'Ensure all parentheses are balanced or escaped with \\',
        }
      }
    }
  }

  if (depth !== 0) {
    return {
      valid: false,
      error: 'Unclosed parenthesis in permission rule',
      suggestion: 'Close the parenthesis or escape literal "(" with "\\("',
    }
  }

  if (hasEmptyParens) {
    return {
      valid: false,
      error: 'Empty parentheses "()" are not valid in permission rules',
      suggestion: 'Omit parentheses to match all uses of the tool',
      examples: ['Bash', 'Read'],
    }
  }

  const parsed = permissionRuleValueFromString(rule)
  const { toolName, ruleContent } = parsed

  if (!toolName) {
    return {
      valid: false,
      error: 'Permission rule must specify a tool name',
    }
  }

  if (toolName.startsWith('mcp__')) {
    const mcpInfo = mcpInfoFromString(toolName)
    if (!mcpInfo) {
      return {
        valid: false,
        error: 'Invalid MCP tool name format',
        examples: ['mcp__server_name', 'mcp__server_name__tool_name'],
      }
    }
    if (firstOpen !== -1 || ruleContent !== undefined) {
      return {
        valid: false,
        error: 'MCP tool rules do not support parameter patterns in parentheses',
        suggestion: `Use "${toolName}" without parentheses`,
        examples: ['mcp__github', 'mcp__github__create_issue'],
      }
    }
    return { valid: true }
  }

  if (!/^[A-Z]/.test(toolName)) {
    return {
      valid: false,
      error: `Tool name "${toolName}" must start with an uppercase letter or "mcp__"`,
      examples: ['Bash(git status)', 'Read(src/**)', 'mcp__server'],
    }
  }

  if (ruleContent !== undefined) {
    const customValidator = getCustomValidation(toolName)
    if (customValidator) {
      return customValidator(ruleContent)
    }

    if (isBashPrefixTool(toolName)) {
      const colonStarIndex = ruleContent.indexOf(':*')
      if (colonStarIndex !== -1) {
        if (ruleContent === ':*') {
          return {
            valid: false,
            error: '":*" requires a command prefix before it',
            examples: ['Bash(git:*)', 'Bash(npm test:*)'],
          }
        }
        if (colonStarIndex !== ruleContent.length - 2) {
          return {
            valid: false,
            error: '":*" wildcard must only appear at the end of a Bash rule',
            suggestion: 'Move ":*" to the end or use "*" glob syntax',
            examples: ['Bash(git commit:*)', 'Bash(npm run *)'],
          }
        }
      }
    }

    if (isFilePatternTool(toolName)) {
      if (ruleContent.includes(':*')) {
        return {
          valid: false,
          error: `File tool "${toolName}" does not use ":*" syntax`,
          suggestion: 'Use standard glob patterns such as "**" or "*"',
          examples: [`${toolName}(src/**)`, `${toolName}(*.ts)`],
        }
      }
      if (
        ruleContent.includes('*') &&
        !ruleContent.includes('**') &&
        !/^\*|\*$|\*\*|\/\*|\*\.|\*\)/.test(ruleContent)
      ) {
        return {
          valid: false,
          error: `Unsupported wildcard placement in ${toolName} rule: "${ruleContent}"`,
          suggestion: 'Use glob wildcards like "src/**", "*.ts", or "dir/*"',
          examples: [`${toolName}(src/**/*.ts)`, `${toolName}(*.json)`],
        }
      }
    }
  }

  return { valid: true }
}

export const PermissionRuleSchema = lazySchema(() =>
  z.string().superRefine((value, ctx) => {
    const result = validatePermissionRule(value)
    if (!result.valid) {
      ctx.addIssue({
        code: 'custom',
        message: result.error ?? `Invalid permission rule: ${value}`,
      })
    }
  }),
)
