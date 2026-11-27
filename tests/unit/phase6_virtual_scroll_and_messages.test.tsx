import { describe, expect, test } from 'bun:test'
import type { UUID } from 'crypto'
import React from 'react'
import { PassThrough } from 'stream'
import { Messages, buildDisplayList } from '../../src/components/messages.js'
import { OffscreenFreeze } from '../../src/components/offscreen_freeze.js'
import { StatusLine } from '../../src/components/status_line.js'
import { App } from '../../src/components/app.js'
import {
  computeVirtualWindow,
  MAX_MOUNTED_ITEMS,
  OVERSCAN_ROWS,
  SCROLL_QUANTUM,
} from '../../src/hooks/use_virtual_scroll.js'
import { render } from '../../src/ink/root.js'
import { Text } from '../../src/ink/components/text.js'
import type { AssistantMessage, Message, UserMessage } from '../../src/types/message.js'
import {
  collapseReadSearchGroups,
  formatCollapsedReadSearchSummary,
} from '../../src/utilities/collapse_read_search.js'
import { findTranscriptMatches } from '../../src/utilities/transcript_search.js'

function createStreams(columns = 90, rows = 30) {
  const stdout = Object.assign(new PassThrough(), {
    columns,
    rows,
    isTTY: false,
  })
  const stdin = Object.assign(new PassThrough(), {
    isTTY: false,
    setRawMode: () => {},
  })
  return { stdout, stdin }
}

function makeUserMsg(idx: number, text: string): UserMessage {
  return {
    type: 'user',
    uuid: `00000000-0000-4000-8000-${String(idx).padStart(12, '0')}` as UUID,
    timestamp: new Date(1_700_000_000_000 + idx * 1000).toISOString(),
    message: { role: 'user', content: text },
  }
}

function makeAssistantTextMsg(idx: number, text: string): AssistantMessage {
  return {
    type: 'assistant',
    uuid: `10000000-0000-4000-8000-${String(idx).padStart(12, '0')}` as UUID,
    timestamp: new Date(1_700_000_000_000 + idx * 1000).toISOString(),
    requestId: undefined,
    message: {
      id: `msg_${idx}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 } as AssistantMessage['message']['usage'],
    } as AssistantMessage['message'],
  }
}

function makeToolUseAssistantMsg(
  idx: number,
  toolName: string,
  toolId: string,
  input: Record<string, unknown>,
): AssistantMessage {
  return {
    type: 'assistant',
    uuid: `20000000-0000-4000-8000-${String(idx).padStart(12, '0')}` as UUID,
    timestamp: new Date(1_700_000_000_000 + idx * 1000).toISOString(),
    requestId: undefined,
    message: {
      id: `tool_${idx}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'tool_use', id: toolId, name: toolName, input }],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 } as AssistantMessage['message']['usage'],
    } as AssistantMessage['message'],
  }
}

function makeToolResultUserMsg(idx: number, toolId: string, content: string): UserMessage {
  return {
    type: 'user',
    uuid: `30000000-0000-4000-8000-${String(idx).padStart(12, '0')}` as UUID,
    timestamp: new Date(1_700_000_000_000 + idx * 1000).toISOString(),
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolId, content }],
    },
  }
}

describe('Phase 6.2 — Virtual Scroll, Message Grouping, OffscreenFreeze & StatusLine', () => {
  test('computeVirtualWindow virtualizes 600-message transcript with 80-line overscan, 40-line quantization, and 300-item cap', () => {
    expect(OVERSCAN_ROWS).toBe(80)
    expect(SCROLL_QUANTUM).toBe(40)
    expect(MAX_MOUNTED_ITEMS).toBe(300)

    const itemCount = 600
    const heights = Array.from({ length: itemCount }, () => 3)

    // Scroll position within same 40-line quantum produces identical mount range (no flicker thrash)
    const w1 = computeVirtualWindow({
      itemCount,
      scrollTop: 405,
      viewportHeight: 30,
      stickyBottom: false,
      heights,
    })
    const w2 = computeVirtualWindow({
      itemCount,
      scrollTop: 435,
      viewportHeight: 30,
      stickyBottom: false,
      heights,
    })
    expect(w1.startIndex).toBe(w2.startIndex)
    expect(w1.endIndex).toBe(w2.endIndex)
    expect(w1.endIndex - w1.startIndex).toBeLessThanOrEqual(MAX_MOUNTED_ITEMS)
    expect(w1.topSpacer).toBeGreaterThan(0)
    expect(w1.bottomSpacer).toBeGreaterThan(0)

    // Dense 1-row items enforce the 300-item hard cap even with huge viewport
    const dense = computeVirtualWindow({
      itemCount: 800,
      scrollTop: 0,
      viewportHeight: 500,
      stickyBottom: false,
      heights: Array.from({ length: 800 }, () => 1),
    })
    expect(dense.endIndex - dense.startIndex).toBeLessThanOrEqual(MAX_MOUNTED_ITEMS)

    // Sticky bottom anchors window to tail of 600 items
    const tail = computeVirtualWindow({
      itemCount,
      scrollTop: 0,
      viewportHeight: 30,
      stickyBottom: true,
      heights,
    })
    expect(tail.endIndex).toBe(itemCount)
    expect(tail.bottomSpacer).toBe(0)
    expect(tail.startIndex).toBeGreaterThan(400)
  })

  test('collapses contiguous Read/Glob/Grep tool turns into a summary group and expands in verbose mode', () => {
    const msgs: Message[] = [
      makeUserMsg(1, 'Inspect the repo'),
      makeToolUseAssistantMsg(2, 'Read', 't1', { file_path: 'src/a.ts' }),
      makeToolResultUserMsg(3, 't1', 'file a'),
      makeToolUseAssistantMsg(4, 'Grep', 't2', { pattern: 'foo' }),
      makeToolResultUserMsg(5, 't2', 'match'),
      makeToolUseAssistantMsg(6, 'Read', 't3', { file_path: 'src/b.ts' }),
      makeToolResultUserMsg(7, 't3', 'file b'),
      makeAssistantTextMsg(8, 'All done inspecting!'),
    ]

    const collapsed = collapseReadSearchGroups(msgs, false)
    expect(collapsed.length).toBe(3) // user + collapsed group + final assistant text
    const mid = collapsed[1]!
    expect(mid.kind).toBe('collapsed_read_search')
    if (mid.kind === 'collapsed_read_search') {
      expect(mid.readCount).toBe(2)
      expect(mid.searchCount).toBe(1)
      expect(formatCollapsedReadSearchSummary(mid)).toBe(
        'Read 2 files, Searched 1 pattern',
      )
    }

    const verbose = buildDisplayList(msgs, true)
    expect(verbose.length).toBe(msgs.length)
  })

  test('incremental transcript search matches user, assistant, and tool payloads', () => {
    const msgs: Message[] = [
      makeUserMsg(1, 'Refactor auth middleware'),
      makeAssistantTextMsg(2, 'Updated JWT verifier cleanly'),
      makeToolUseAssistantMsg(3, 'Grep', 't1', { pattern: 'verifyToken' }),
    ]
    expect(findTranscriptMatches(msgs, 'jwt')).toEqual([1])
    expect(findTranscriptMatches(msgs, 'verifytoken')).toEqual([2])
    expect(findTranscriptMatches(msgs, 'nonexistent')).toEqual([])
  })

  test('OffscreenFreeze blocks re-renders of frozen historical rows during streaming tail updates', () => {
    const { stdout, stdin } = createStreams()
    let frozenRenderCount = 0

    function HistoricalRow({ label }: { label: string }) {
      frozenRenderCount++
      return <Text>{label}</Text>
    }

    const inst = render(
      <App>
        <OffscreenFreeze frozen={true}>
          <HistoricalRow label="v1" />
        </OffscreenFreeze>
      </App>,
      { stdout, stdin },
    )
    expect(frozenRenderCount).toBe(1)

    inst.rerender(
      <App>
        <OffscreenFreeze frozen={true}>
          <HistoricalRow label="v2" />
        </OffscreenFreeze>
      </App>,
    )
    inst.flush()
    expect(frozenRenderCount).toBe(1)
    inst.unmount()
  })

  test('Messages renders a 550-message fullscreen transcript smoothly via VirtualMessageList', () => {
    const { stdout, stdin } = createStreams(80, 24)
    const messages: Message[] = []
    for (let i = 0; i < 275; i++) {
      messages.push(makeUserMsg(i * 2, `Question #${i}`))
      messages.push(makeAssistantTextMsg(i * 2 + 1, `Answer #${i}`))
    }
    const scrollRef = React.createRef<import('../../src/ink/components/scroll_box.js').ScrollBoxHandle | null>()

    const inst = render(
      <App>
        <Messages
          messages={messages}
          columns={80}
          viewportHeight={20}
          scrollRef={scrollRef}
          fullscreen={true}
          stickyBottom={true}
        />
      </App>,
      { stdout, stdin },
    )
    const output = inst.ink.getPlainScreenLines().join('\n')
    expect(output).toContain('Answer #274')
    expect(output).not.toContain('Question #0')
    inst.unmount()
  })

  test('StatusLine debounces external statusline command calls by 300ms', async () => {
    const { stdout, stdin } = createStreams()
    let runs = 0
    const runner = async () => {
      runs++
      return 'git:main ✓'
    }

    const inst = render(
      <App>
        <StatusLine
          cwd="/repo"
          model="claude-sonnet-4-6"
          permissionMode="default"
          statusLineCommand="echo git:main"
          commandRunner={runner}
        />
      </App>,
      { stdout, stdin },
    )
    expect(runs).toBe(0)
    await new Promise(r => setTimeout(r, 360))
    inst.flush()
    expect(runs).toBe(1)
    expect(inst.ink.getPlainScreenLines().join('\n')).toContain('git:main')
    inst.unmount()
  })
})
