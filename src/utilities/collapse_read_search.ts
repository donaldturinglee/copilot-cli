import type { Message } from '../types/message.js'

const READ_SEARCH_TOOL_NAMES = new Set([
  'Read',
  'FileRead',
  'Glob',
  'Grep',
  'LS',
  'ToolSearch',
])

export type CollapsedReadSearchGroup = {
  kind: 'collapsed_read_search'
  id: string
  messages: Message[]
  readCount: number
  searchCount: number
  listCount: number
  toolNames: string[]
}

export type DisplayListItem =
  | { kind: 'message'; id: string; message: Message }
  | CollapsedReadSearchGroup

function classifyReadSearchMessage(
  msg: Message,
): { reads: number; searches: number; lists: number; names: string[] } | null {
  if (msg.type !== 'assistant') return null
  const content = msg.message.content
  if (!Array.isArray(content) || content.length === 0) return null

  let reads = 0
  let searches = 0
  let lists = 0
  const names: string[] = []

  for (const block of content) {
    if (block.type === 'text' && block.text.trim().length > 0) {
      return null // Assistant produced visible prose -> do not collapse
    }
    if (block.type === 'tool_use') {
      if (!READ_SEARCH_TOOL_NAMES.has(block.name)) {
        return null
      }
      names.push(block.name)
      if (block.name === 'Read' || block.name === 'FileRead') reads++
      else if (block.name === 'LS') lists++
      else searches++
    }
  }

  return names.length > 0 ? { reads, searches, lists, names } : null
}

/**
 * Group contiguous read/search-only tool turns (and their paired tool_result
 * user messages) into a single collapsible summary item to keep the transcript
 * scannable.
 */
export function collapseReadSearchGroups(
  messages: readonly Message[],
  verbose = false,
): DisplayListItem[] {
  if (verbose) {
    return messages.map((m, idx) => ({
      kind: 'message',
      id: `${m.uuid}-${idx}`,
      message: m,
    }))
  }

  const out: DisplayListItem[] = []
  let activeGroup: CollapsedReadSearchGroup | null = null

  const flushGroup = (): void => {
    if (!activeGroup) return
    if (activeGroup.toolNames.length >= 2) {
      out.push(activeGroup)
    } else {
      for (let i = 0; i < activeGroup.messages.length; i++) {
        const m = activeGroup.messages[i]!
        out.push({ kind: 'message', id: `${m.uuid}-${out.length}`, message: m })
      }
    }
    activeGroup = null
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    const info = classifyReadSearchMessage(msg)

    if (info) {
      if (!activeGroup) {
        activeGroup = {
          kind: 'collapsed_read_search',
          id: `collapsed-${msg.uuid}`,
          messages: [msg],
          readCount: info.reads,
          searchCount: info.searches,
          listCount: info.lists,
          toolNames: [...info.names],
        }
      } else {
        activeGroup.messages.push(msg)
        activeGroup.readCount += info.reads
        activeGroup.searchCount += info.searches
        activeGroup.listCount += info.lists
        activeGroup.toolNames.push(...info.names)
      }
      continue
    }

    // Absorb tool_result-only user messages immediately following a collapsed read/search turn
    if (
      activeGroup &&
      msg.type === 'user' &&
      Array.isArray(msg.message.content) &&
      msg.message.content.length > 0 &&
      msg.message.content.every(b => b.type === 'tool_result')
    ) {
      activeGroup.messages.push(msg)
      continue
    }

    flushGroup()
    out.push({ kind: 'message', id: `${msg.uuid}-${i}`, message: msg })
  }

  flushGroup()
  return out
}

export function formatCollapsedReadSearchSummary(
  group: CollapsedReadSearchGroup,
): string {
  const parts: string[] = []
  if (group.readCount > 0) {
    parts.push(`Read ${group.readCount} ${group.readCount === 1 ? 'file' : 'files'}`)
  }
  if (group.searchCount > 0) {
    parts.push(
      `Searched ${group.searchCount} ${group.searchCount === 1 ? 'pattern' : 'patterns'}`,
    )
  }
  if (group.listCount > 0) {
    parts.push(`Listed ${group.listCount} ${group.listCount === 1 ? 'dir' : 'dirs'}`)
  }
  return parts.join(', ') || `Ran ${group.toolNames.length} read-only tools`
}
