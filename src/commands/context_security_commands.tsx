import type { UUID } from 'crypto'
import React from 'react'
import { ContextVisualization } from '../components/context_visualization.js'
import { HooksDialog } from '../components/hooks/hooks_dialog.js'
import { SandboxDialog } from '../components/sandbox/sandbox_dialog.js'
import { ConfigDialog } from '../components/settings/config_dialog.js'
import { Stats } from '../components/stats.js'
import { clearContextCaches } from '../context.js'
import { formatTotalCost, getTotalInputTokens, getTotalOutputTokens } from '../cost_tracker.js'
import { compactConversation } from '../services/compact/compact.js'
import { suppressCompactWarning } from '../services/compact/compact_warning_state.js'
import { runPostCompactCleanup } from '../services/compact/post_compact_cleanup.js'
import { trySessionMemoryCompaction } from '../services/compact/session_memory_compact.js'
import { setLastSummarizedMessageId } from '../services/session_memory/session_memory_utils.js'
import type { Command } from '../types/command.js'
import type { ToolUseContext } from '../types/forward.js'
import type { Message, SystemCompactBoundaryMessage } from '../types/message.js'
import { analyzeContextBreakdown } from '../utilities/analyze_context.js'
import { getLastCacheSafeParams } from '../utilities/cache_safe_params.js'
import { randomUUID } from '../utilities/crypto.js'
import { getDefaultMainLoopModel } from '../utilities/model/model.js'
import { computeSessionStats } from '../utilities/stats.js'
import { makeLocalCommand, makeLocalJsxCommand } from './registry.js'
import { getCommandRuntime } from './session_commands.js'

export const CONTEXT_SECURITY_COMMANDS: Command[] = [
  makeLocalCommand({
    name: 'compact',
    description: 'Compact older conversation turns into a concise boundary summary',
    argumentHint: '[focus instructions]',
    call: async (args, context) => {
      const count = context.messages.length
      if (count <= 2) {
        return { type: 'text', value: 'Conversation is already concise.' }
      }

      const customInstructions = args.trim() || undefined

      // Tier 4a: try zero-LLM Session Memory compaction when no custom focus instructions
      if (!customInstructions) {
        const smResult = await trySessionMemoryCompaction(context.messages).catch(
          () => null,
        )
        if (smResult) {
          const nextMessages: Message[] = [
            smResult.boundaryMarker,
            ...smResult.summaryMessages,
            ...(smResult.messagesToKeep ?? []),
            ...smResult.attachments,
            ...smResult.hookResults,
          ]
          context.setMessages(() => nextMessages)
          suppressCompactWarning()
          setLastSummarizedMessageId(undefined)
          runPostCompactCleanup('compact')
          clearContextCaches()
          return {
            type: 'text',
            value: `Compacted conversation using session memory (${smResult.preCompactTokenCount ?? 0} -> ${smResult.postCompactTokenCount ?? 0} tokens).`,
          }
        }
      }

      // Tier 4b: Full LLM compaction when CacheSafeParams are available from a live session
      const cacheSafeParams = getLastCacheSafeParams()
      if (cacheSafeParams && process.env.NODE_ENV !== 'test') {
        try {
          const toolUseContext: ToolUseContext = {
            abortController: context.abortController,
            messages: context.messages,
            readFileState: context.readFileState,
            getAppState: getCommandRuntime(context).getAppState,
            setAppState: getCommandRuntime(context).setAppState,
          }
          const result = await compactConversation(
            context.messages,
            toolUseContext,
            cacheSafeParams,
            false,
            customInstructions,
            false,
          )
          const nextMessages: Message[] = [
            result.boundaryMarker,
            ...result.summaryMessages,
            ...result.attachments,
            ...result.hookResults,
          ]
          context.setMessages(() => nextMessages)
          suppressCompactWarning()
          setLastSummarizedMessageId(undefined)
          runPostCompactCleanup('compact')
          clearContextCaches()
          return {
            type: 'text',
            value: `Compacted ${count} messages (${result.preCompactTokenCount ?? 0} -> ${result.postCompactTokenCount ?? 0} tokens).`,
          }
        } catch {
          // Fall back cleanly to local boundary truncation when offline/unauthenticated
        }
      }

      const keepTail = context.messages.slice(-2)
      const boundary: SystemCompactBoundaryMessage = {
        type: 'system',
        subtype: 'compact_boundary',
        level: 'info',
        content: customInstructions
          ? `Compacted ${count - keepTail.length} earlier messages (focus: ${customInstructions})`
          : `Compacted ${count - keepTail.length} earlier messages`,
        compactMetadata: {
          trigger: 'manual',
          preTokens: getTotalInputTokens() + getTotalOutputTokens(),
          messagesSummarized: count - keepTail.length,
          ...(customInstructions ? { userContext: customInstructions } : {}),
        },
        uuid: randomUUID() as UUID,
        timestamp: new Date().toISOString(),
      }
      context.setMessages(() => [boundary, ...keepTail])
      suppressCompactWarning()
      setLastSummarizedMessageId(undefined)
      runPostCompactCleanup('compact')
      clearContextCaches()
      return {
        type: 'text',
        value: `Compacted ${count - keepTail.length} messages.`,
      }
    },
  }),

  makeLocalJsxCommand({
    name: 'context',
    description: 'Visualize current context window usage',
    immediate: true,
    call: async (onDone, context) => {
      const runtime = getCommandRuntime(context)
      const model =
        runtime.getAppState?.().mainLoopModel ?? getDefaultMainLoopModel()
      const breakdown = await analyzeContextBreakdown({
        messages: context.messages,
        model,
      })
      const reportedUsed = getTotalInputTokens() + getTotalOutputTokens()
      const used = Math.max(reportedUsed, breakdown.totalTokens)
      return (
        <ContextVisualization
          usedTokens={used}
          contextWindow={breakdown.contextWindow}
          messageCount={context.messages.length}
          toolCount={0}
          onClose={() => onDone()}
        />
      )
    },
  }),

  makeLocalCommand({
    name: 'cost',
    description: 'Show session token usage and USD cost breakdown',
    immediate: true,
    call: async () => ({
      type: 'text',
      value: formatTotalCost(),
    }),
  }),

  makeLocalCommand({
    name: 'files',
    description: 'List files tracked in the current conversation read cache',
    call: async (_args, context) => {
      const cache = context.readFileState as
        | { keys?: () => IterableIterator<string> }
        | undefined
      const files = cache?.keys ? Array.from(cache.keys()) : []
      if (files.length === 0) {
        return { type: 'text', value: 'No files currently tracked in context.' }
      }
      return {
        type: 'text',
        value: `Tracked files (${files.length}):\n${files.map(f => `  • ${f}`).join('\n')}`,
      }
    },
  }),

  makeLocalJsxCommand({
    name: 'stats',
    description: 'Display session turn, token, cost, and code-change statistics',
    immediate: true,
    call: async (onDone, context) => (
      <Stats
        stats={computeSessionStats(context.messages)}
        onClose={() => onDone()}
      />
    ),
  }),

  makeLocalCommand({
    name: 'insights',
    description: 'Summarize session productivity metrics and tool usage insights',
    call: async (_args, context) => {
      const s = computeSessionStats(context.messages)
      return {
        type: 'text',
        value: `Session insights: ${s.userTurns} prompts, ${s.toolCalls} tool executions, +${s.linesAdded}/-${s.linesRemoved} lines changed.`,
      }
    },
  }),

  makeLocalJsxCommand({
    name: 'permissions',
    description: 'View and configure permission modes and allow/deny rules',
    call: async onDone => (
      <ConfigDialog
        initialTab="permissions"
        onClose={summary => onDone(summary)}
      />
    ),
  }),

  makeLocalJsxCommand({
    name: 'sandbox',
    description: 'Inspect and toggle OS sandbox isolation settings',
    call: async onDone => (
      <SandboxDialog onClose={summary => onDone(summary)} />
    ),
  }),

  makeLocalJsxCommand({
    name: 'hooks',
    description: 'Inspect configured lifecycle hooks across all 27 events',
    call: async onDone => <HooksDialog onClose={() => onDone()} />,
  }),
]

export function getPermissionSummaryText(
  context: Parameters<typeof getCommandRuntime>[0],
): string {
  const mode = getCommandRuntime(context).getAppState?.().toolPermissionContext.mode ?? 'default'
  return `Permission mode: ${mode}`
}
