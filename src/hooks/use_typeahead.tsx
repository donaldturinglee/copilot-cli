import { useCallback, useMemo, useState } from 'react'
import type { PromptHistoryEntry } from '../history.js'
import type { Command } from '../types/command.js'
import {
  type ContextSuggestion,
  getContextSuggestions,
} from '../utilities/context_suggestions.js'
import {
  getCommandArgSuggestions,
  getCommandSuggestions,
  type SuggestionItem,
} from '../utilities/suggestions/command_suggestions.js'
import { getDirectorySuggestions } from '../utilities/suggestions/directory_completion.js'
import {
  type FileSuggestionEngine,
  type MentionResource,
} from '../utilities/suggestions/file_suggestions.js'
import { getShellHistorySuggestions } from '../utilities/suggestions/shell_history_completion.js'

export type TypeaheadTier =
  | 'none'
  | 'tier1_midline_slash'
  | 'tier2_shell_history'
  | 'tier3_member_mention'
  | 'tier4_command_args'
  | 'tier5_leading_slash'
  | 'tier6_file_mcp_agent'
  | 'tier7_directory_path'
  | 'tier8_context_suggestion'

export type TypeaheadResolution = {
  tier: TypeaheadTier
  replaceStart: number
  replaceEnd: number
  suggestions: SuggestionItem[]
}

export type ResolveTypeaheadParams = {
  input: string
  cursor: number
  commands: readonly Command[]
  fileEngine: FileSuggestionEngine
  historyEntries?: readonly PromptHistoryEntry[]
  members?: readonly MentionResource[]
  mcpResources?: readonly MentionResource[]
  agents?: readonly MentionResource[]
  contextSuggestions?: readonly ContextSuggestion[]
  cwd?: string
  showContextWhenEmpty?: boolean
}

/**
 * Pure 8-tier priority typeahead resolver:
 * 1. Mid-line `/command` token
 * 2. `!` shell history completion
 * 3. `@member` teammate mention
 * 4. Leading `/command <arg>` argument completion
 * 5. Leading `/` fuzzy slash command search (with usage-decay boost)
 * 6. Unified `@file` / MCP / Agent completion (backed by `FileIndex`)
 * 7. Shell Tab directory/path completion (`!cmd ./foo` or `./foo`)
 * 8. Context suggestions
 */
export function resolveTypeahead(
  params: ResolveTypeaheadParams,
): TypeaheadResolution {
  const {
    input,
    cursor,
    commands,
    fileEngine,
    historyEntries = [],
    members = [],
    mcpResources = [],
    agents = [],
    contextSuggestions,
    cwd = process.cwd(),
    showContextWhenEmpty = false,
  } = params

  const clampedCursor = Math.max(0, Math.min(cursor, input.length))
  const before = input.slice(0, clampedCursor)

  // Find current whitespace-delimited token ending at cursor
  const tokenStart = (() => {
    let i = before.length
    while (i > 0 && !/\s/.test(before[i - 1]!)) i--
    return i
  })()
  const token = before.slice(tokenStart)

  // Tier 1: Mid-line `/` command completion (not at index 0)
  if (tokenStart > 0 && token.startsWith('/') && !token.slice(1).includes('/')) {
    const suggestions = getCommandSuggestions(token, commands, 8)
    if (suggestions.length > 0) {
      return {
        tier: 'tier1_midline_slash',
        replaceStart: tokenStart,
        replaceEnd: clampedCursor,
        suggestions,
      }
    }
  }

  // Tier 2: `!` shell history completion
  if (before.startsWith('!')) {
    const queryAfterBang = before.slice(1)
    // Tier 7 inside `!cmd path/` if user typed a path token after command name
    if (
      tokenStart > 1 &&
      (token.startsWith('./') ||
        token.startsWith('../') ||
        token.includes('/') ||
        token.includes('\\'))
    ) {
      const dirSuggestions = getDirectorySuggestions(token, cwd, 10)
      if (dirSuggestions.length > 0) {
        return {
          tier: 'tier7_directory_path',
          replaceStart: tokenStart,
          replaceEnd: clampedCursor,
          suggestions: dirSuggestions,
        }
      }
    }
    const histSuggestions = getShellHistorySuggestions(
      queryAfterBang,
      historyEntries,
      8,
    )
    if (histSuggestions.length > 0) {
      return {
        tier: 'tier2_shell_history',
        replaceStart: 0,
        replaceEnd: clampedCursor,
        suggestions: histSuggestions,
      }
    }
  }

  // Tier 3: `@member` teammate mention (takes precedence over generic `@file` when member matches)
  if (token.startsWith('@') && members.length > 0) {
    const q = token.slice(1).toLowerCase()
    const matchedMembers = members
      .filter(m => !q || m.label.toLowerCase().includes(q))
      .map(
        (m): SuggestionItem => ({
          id: `member:${m.id}`,
          displayText: `@${m.label}`,
          insertText: `@${m.label} `,
          description: m.description ?? 'teammate',
          kind: 'member',
          score: m.label.toLowerCase().startsWith(q) ? 100 : 80,
        }),
      )
    if (matchedMembers.length > 0 && q.length > 0) {
      return {
        tier: 'tier3_member_mention',
        replaceStart: tokenStart,
        replaceEnd: clampedCursor,
        suggestions: matchedMembers,
      }
    }
  }

  // Tier 4: Leading `/command <arg>` argument completion
  if (before.startsWith('/') && /\s/.test(before)) {
    const spaceIdx = before.search(/\s/)
    const cmdName = before.slice(1, spaceIdx)
    const argPrefix = before.slice(spaceIdx + 1)
    const argSuggestions = getCommandArgSuggestions(cmdName, argPrefix, 8)
    if (argSuggestions.length > 0) {
      return {
        tier: 'tier4_command_args',
        replaceStart: 0,
        replaceEnd: clampedCursor,
        suggestions: argSuggestions,
      }
    }
  }

  // Tier 5: Leading `/` fuzzy slash command search + skill usage decay
  if (before.startsWith('/') && !/\s/.test(before) && !before.slice(1).includes('/')) {
    const cmdSuggestions = getCommandSuggestions(before, commands, 10)
    if (cmdSuggestions.length > 0) {
      return {
        tier: 'tier5_leading_slash',
        replaceStart: 0,
        replaceEnd: clampedCursor,
        suggestions: cmdSuggestions,
      }
    }
  }

  // Tier 6: Unified `@file` / MCP / Agent fuzzy completion via `FileIndex`
  if (token.startsWith('@')) {
    const query = token.slice(1)
    const extraResources: MentionResource[] = [
      ...members,
      ...mcpResources,
      ...agents,
    ]
    const fileSuggestions = fileEngine.search(query, {
      limit: 12,
      extraResources,
    })
    if (fileSuggestions.length > 0) {
      return {
        tier: 'tier6_file_mcp_agent',
        replaceStart: tokenStart,
        replaceEnd: clampedCursor,
        suggestions: fileSuggestions,
      }
    }
  }

  // Tier 7: Standalone directory/path completion (`./...` or `../...`)
  if (token.startsWith('./') || token.startsWith('../')) {
    const dirSuggestions = getDirectorySuggestions(token, cwd, 10)
    if (dirSuggestions.length > 0) {
      return {
        tier: 'tier7_directory_path',
        replaceStart: tokenStart,
        replaceEnd: clampedCursor,
        suggestions: dirSuggestions,
      }
    }
  }

  // Tier 8: Context suggestions
  if (showContextWhenEmpty && input.trim().length === 0) {
    const ctxItems = getContextSuggestions('', contextSuggestions).map(
      (c, idx): SuggestionItem => ({
        id: c.id,
        displayText: c.label,
        insertText: c.insertText,
        description: c.description,
        kind: 'context',
        score: 50 - idx,
      }),
    )
    if (ctxItems.length > 0) {
      return {
        tier: 'tier8_context_suggestion',
        replaceStart: 0,
        replaceEnd: clampedCursor,
        suggestions: ctxItems,
      }
    }
  }

  return {
    tier: 'none',
    replaceStart: clampedCursor,
    replaceEnd: clampedCursor,
    suggestions: [],
  }
}

export function applyTypeaheadSelection(
  input: string,
  resolution: TypeaheadResolution,
  item: SuggestionItem,
): { text: string; cursor: number } {
  const before = input.slice(0, resolution.replaceStart)
  const after = input.slice(resolution.replaceEnd)
  const text = `${before}${item.insertText}${after}`
  const cursor = before.length + item.insertText.length
  return { text, cursor }
}

export function useTypeahead(params: ResolveTypeaheadParams) {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [dismissedForInput, setDismissedForInput] = useState<string | null>(
    null,
  )

  const resolution = useMemo(() => {
    if (dismissedForInput === params.input) {
      return {
        tier: 'none' as TypeaheadTier,
        replaceStart: params.cursor,
        replaceEnd: params.cursor,
        suggestions: [],
      }
    }
    return resolveTypeahead(params)
  }, [
    dismissedForInput,
    params.input,
    params.cursor,
    params.commands,
    params.fileEngine,
    params.historyEntries,
    params.members,
    params.mcpResources,
    params.agents,
    params.contextSuggestions,
    params.cwd,
    params.showContextWhenEmpty,
  ])

  const safeIndex =
    resolution.suggestions.length > 0
      ? Math.min(selectedIndex, resolution.suggestions.length - 1)
      : 0

  const selectNext = useCallback(() => {
    setSelectedIndex(prev =>
      resolution.suggestions.length === 0
        ? 0
        : (prev + 1) % resolution.suggestions.length,
    )
  }, [resolution.suggestions.length])

  const selectPrevious = useCallback(() => {
    setSelectedIndex(prev =>
      resolution.suggestions.length === 0
        ? 0
        : (prev - 1 + resolution.suggestions.length) %
          resolution.suggestions.length,
    )
  }, [resolution.suggestions.length])

  const dismiss = useCallback(() => {
    setDismissedForInput(params.input)
  }, [params.input])

  const acceptSelected = useCallback((): {
    text: string
    cursor: number
  } | null => {
    const item = resolution.suggestions[safeIndex]
    if (!item) return null
    setSelectedIndex(0)
    return applyTypeaheadSelection(params.input, resolution, item)
  }, [params.input, resolution, safeIndex])

  return {
    tier: resolution.tier,
    suggestions: resolution.suggestions,
    selectedIndex: safeIndex,
    isOpen: resolution.suggestions.length > 0,
    selectNext,
    selectPrevious,
    acceptSelected,
    dismiss,
  }
}
