import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { UUID } from 'crypto'
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { getAllCommands } from '../commands.js'
import { useTheme } from '../components/design_system/theme_provider.js'
import { ThemedText } from '../components/design_system/themed_text.js'
import { FullscreenLayout } from '../components/fullscreen_layout.js'
import { GlobalSearchDialog } from '../components/global_search_dialog.js'
import { HistorySearchDialog } from '../components/history_search_dialog.js'
import { LogoV2 } from '../components/logo_v2.js'
import { Messages } from '../components/messages.js'
import { PermissionRequest } from '../components/permissions/permission_request.js'
import { PromptInput } from '../components/prompt_input/prompt_input.js'
import { QuickOpenDialog } from '../components/quick_open_dialog.js'
import { ScrollKeybindingHandler } from '../components/scroll_keybinding_handler.js'
import { Spinner } from '../components/spinner.js'
import { StatusLine } from '../components/status_line.js'
import { StatusNotices, type StatusNotice } from '../components/status_notices.js'
import { TokenWarning } from '../components/token_warning.js'
import { getTotalInputTokens, getTotalOutputTokens } from '../cost_tracker.js'
import { appendHistory, readHistory, type PromptHistoryEntry } from '../history.js'
import { useCanUseTool } from '../hooks/use_can_use_tool.js'
import { useCancelRequest } from '../hooks/use_cancel_request.js'
import { useCommandQueue } from '../hooks/use_command_queue.js'
import { useMainLoopModel } from '../hooks/use_main_loop_model.js'
import { useTerminalSize } from '../hooks/use_terminal_size.js'
import { Box } from '../ink/components/box.js'
import type { ScrollBoxHandle } from '../ink/components/scroll_box.js'
import type { InputEvent } from '../ink/events/input_event.js'
import type { Key } from '../ink/events/keyboard_event.js'
import { useApp } from '../ink/hooks/use_app.js'
import { useInput } from '../ink/hooks/use_input.js'
import {
  buildReplCommandContext,
  createInteractiveQueryEngine,
} from '../interactive_helpers.js'
import type { QueryEngine } from '../query_engine.js'
import type { QueryDeps } from '../query/deps.js'
import {
  useAppState,
  useAppStateStore,
  useSetAppState,
} from '../state/app_state.js'
import type { Command } from '../types/command.js'
import type {
  AssistantMessage,
  Message,
  SystemLocalCommandMessage,
} from '../types/message.js'
import { getGlobalConfig } from '../utilities/config.js'
import { randomUUID } from '../utilities/crypto.js'
import { getCwd } from '../utilities/cwd.js'
import { MessageQueueManager } from '../utilities/message_queue_manager.js'
import { getNextPermissionMode } from '../utilities/permissions/get_next_permission_mode.js'
import type { BashExecutorFn } from '../utilities/process_user_input/process_bash_command.js'
import { processUserInput } from '../utilities/process_user_input/process_user_input.js'
import {
  FileSuggestionEngine,
  getSharedFileSuggestionEngine,
} from '../utilities/suggestions/file_suggestions.js'

export type ReplProps = {
  initialPrompt?: string
  initialMessages?: Message[]
  commands?: Command[]
  cwd?: string
  fullscreen?: boolean
  queryEngine?: QueryEngine
  queryDeps?: QueryDeps
  fileEngine?: FileSuggestionEngine
  bashExecutor?: BashExecutorFn
  historyPath?: string
  skipHooks?: boolean
  onExit?: () => void
  onMessagesChange?: (messages: readonly Message[]) => void
}

type ActiveModal = 'none' | 'history' | 'search' | 'quick_open'

/**
 * Interactive 3-slot Copilot CLI REPL integrating:
 * - Fullscreen virtualized transcript / Main-screen OffscreenFreeze
 * - Streaming `QueryEngine` multi-turn loop with live Spinner & cancellation
 * - Normal & 11-state Vim `PromptInput` with 8-tier Typeahead & paste folding
 * - Embedded per-tool `<PermissionRequest>` approval dialogs
 * - Complete Slash command dispatch (`local`, `local-jsx`, `prompt`) & `!` shell mode
 */
export function REPL({
  initialPrompt,
  initialMessages = [],
  commands: propCommands,
  cwd: propCwd,
  fullscreen = false,
  queryEngine: externalEngine,
  queryDeps,
  fileEngine: propFileEngine,
  bashExecutor,
  historyPath,
  skipHooks = false,
  onExit,
  onMessagesChange,
}: ReplProps): React.ReactNode {
  const cwd = propCwd ?? getCwd()
  const { columns, rows } = useTerminalSize()
  const { exit: exitInk } = useApp()
  const [theme] = useTheme()
  const store = useAppStateStore()
  const setAppState = useSetAppState()
  const permissionMode = useAppState(s => s.toolPermissionContext.mode)
  const verbose = useAppState(s => s.verbose)
  const effort = useAppState(s => s.effortValue)
  const fastMode = useAppState(s => s.fastMode)
  const statusLineCommand = useAppState(s => s.settings.statusLine?.command)
  const mainLoopModel = useMainLoopModel()

  const commands = useMemo(
    () => propCommands ?? getAllCommands(),
    [propCommands],
  )
  const fileEngine = useMemo(() => {
    const eng = propFileEngine ?? getSharedFileSuggestionEngine()
    if (!propFileEngine && eng.size() === 0) {
      eng.ensureIndexed(cwd, 2000)
    }
    return eng
  }, [propFileEngine, cwd])

  const queueManagerRef = useRef<MessageQueueManager | null>(null)
  if (!queueManagerRef.current) {
    queueManagerRef.current = new MessageQueueManager()
  }
  const queue = useCommandQueue(queueManagerRef.current)

  const { canUseTool, pendingRequest, resolvePendingRequest } = useCanUseTool()
  const { beginRequest, cancelRequest, clearRequest } = useCancelRequest()

  const engineRef = useRef<QueryEngine | null>(externalEngine ?? null)
  if (!engineRef.current) {
    engineRef.current = createInteractiveQueryEngine({
      cwd,
      canUseTool,
      getAppState: () => store.getState(),
      setAppState,
      initialMessages,
      commands,
      deps: queryDeps,
    })
  }

  const [messages, setMessagesState] = useState<Message[]>(() => [
    ...initialMessages,
  ])
  const messagesRef = useRef<Message[]>(messages)
  messagesRef.current = messages

  const setMessages = useCallback(
    (updater: (prev: Message[]) => Message[]) => {
      setMessagesState(prev => {
        const next = updater(prev)
        messagesRef.current = next
        onMessagesChange?.(next)
        return next
      })
    },
    [onMessagesChange],
  )

  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [streamingUuid, setStreamingUuid] = useState<string | null>(null)
  const [vimEnabled, setVimEnabled] = useState<boolean>(
    () => getGlobalConfig().editorMode === 'vim',
  )
  const [activeCommandOverlay, setActiveCommandOverlay] =
    useState<React.ReactNode>(null)
  const [activeModal, setActiveModal] = useState<ActiveModal>('none')
  const [notices, setNotices] = useState<StatusNotice[]>([])
  const [historyEntries, setHistoryEntries] = useState<PromptHistoryEntry[]>(
    () => readHistory({ historyPath }),
  )

  const scrollRef = useRef<ScrollBoxHandle | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [stickyBottom, setStickyBottom] = useState(true)
  const [jumpToIndex, setJumpToIndex] = useState<number | null>(null)

  const appendSystemInfo = useCallback(
    (text: string, level: 'info' | 'warning' = 'info') => {
      const msg: SystemLocalCommandMessage = {
        type: 'system',
        subtype: 'local_command',
        content: text,
        level,
        uuid: randomUUID() as UUID,
        timestamp: new Date().toISOString(),
      }
      setMessages(prev => [...prev, msg])
    },
    [setMessages],
  )

  const handleRequestExit = useCallback(() => {
    cancelRequest()
    if (onExit) onExit()
    else exitInk()
  }, [cancelRequest, onExit, exitInk])

  const submitToModel = useCallback(
    async (
      promptPayload: string | import('@anthropic-ai/sdk/resources/index.mjs').ContentBlockParam[],
    ) => {
      const engine = engineRef.current!
      const ac = beginRequest()
      setIsLoading(true)
      const draftId = randomUUID() as UUID
      let streamedText = ''

      try {
        for await (const sdkMsg of engine.submitMessage(promptPayload)) {
          if (ac.signal.aborted) break

          if (sdkMsg.type === 'stream_event') {
            const ev = sdkMsg.event
            if (
              ev.type === 'content_block_delta' &&
              ev.delta.type === 'text_delta'
            ) {
              streamedText += ev.delta.text
              setStreamingUuid(draftId)
              const liveMsg: AssistantMessage = {
                type: 'assistant',
                uuid: draftId,
                timestamp: new Date().toISOString(),
                requestId: undefined,
                message: {
                  id: draftId,
                  type: 'message',
                  role: 'assistant',
                  model: mainLoopModel,
                  content: [{ type: 'text', text: streamedText }],
                  stop_reason: null,
                  stop_sequence: null,
                  usage: {
                    input_tokens: 0,
                    output_tokens: 0,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                  } as BetaMessage['usage'],
                } as BetaMessage,
              }
              setMessages(prev => {
                const idx = prev.findIndex(m => m.uuid === draftId)
                if (idx >= 0) {
                  const copy = [...prev]
                  copy[idx] = liveMsg
                  return copy
                }
                return [...prev, liveMsg]
              })
            }
          } else if (sdkMsg.type === 'assistant') {
            const finalAssistant: AssistantMessage = {
              type: 'assistant',
              uuid: sdkMsg.uuid as UUID,
              timestamp: new Date().toISOString(),
              requestId: undefined,
              message: sdkMsg.message as BetaMessage,
            }
            setMessages(prev => {
              const withoutDraft = prev.filter(m => m.uuid !== draftId)
              const existingIdx = withoutDraft.findIndex(
                m => m.uuid === finalAssistant.uuid,
              )
              if (existingIdx >= 0) {
                const copy = [...withoutDraft]
                copy[existingIdx] = finalAssistant
                return copy
              }
              return [...withoutDraft, finalAssistant]
            })
            setStreamingUuid(null)
          }
        }
      } catch (err) {
        appendSystemInfo(
          `Error: ${err instanceof Error ? err.message : String(err)}`,
          'warning',
        )
      } finally {
        clearRequest()
        setStreamingUuid(null)
        setIsLoading(false)
      }
    },
    [beginRequest, clearRequest, mainLoopModel, setMessages, appendSystemInfo],
  )

  const handleUserSubmit = useCallback(
    async (rawText: string) => {
      const trimmed = rawText.trim()
      if (!trimmed) return

      setInput('')
      const recorded = appendHistory(trimmed, { historyPath })
      if (recorded) {
        setHistoryEntries(prev => [recorded, ...prev])
      }

      const cmdContext = buildReplCommandContext({
        messages: messagesRef.current,
        setMessages,
        abortController: new AbortController(),
        theme,
        canUseTool,
        readFileState: engineRef.current?.getReadFileState(),
        runtime: {
          getAppState: () => store.getState(),
          setAppState,
          onRequestExit: handleRequestExit,
          onToggleVim: explicit => {
            let nextVal = false
            setVimEnabled(prev => {
              nextVal = explicit !== undefined ? explicit : !prev
              return nextVal
            })
            return explicit !== undefined ? explicit : !vimEnabled
          },
          getAllCommands: () => commands,
        },
      })

      const routed = await processUserInput({
        input: rawText,
        commands,
        context: cmdContext,
        isLoading,
        queueManager: queueManagerRef.current!,
        permissionMode,
        cwd,
        skipHooks,
        bashExecutor,
        onLocalJsxDone: (result, opts) => {
          setActiveCommandOverlay(null)
          if (result) {
            appendSystemInfo(result)
          }
          if (opts?.nextInput) {
            setInput(opts.nextInput)
          }
        },
      })

      switch (routed.kind) {
        case 'empty':
          return
        case 'queued':
          setNotices([
            {
              id: routed.queueId,
              text: `Queued while streaming: "${routed.text.slice(0, 48)}"`,
              level: 'info',
            },
          ])
          return
        case 'bash':
          setMessages(prev => [...prev, routed.result.userMessage])
          return
        case 'slash': {
          const r = routed.result
          if (r.kind === 'local_text') {
            setMessages(prev => [...prev, ...r.messages])
          } else if (r.kind === 'local_jsx') {
            if (r.element) setActiveCommandOverlay(r.element)
          } else if (r.kind === 'prompt') {
            await submitToModel(r.blocks)
          } else if (r.kind === 'not_found') {
            appendSystemInfo(r.error, 'warning')
          }
          return
        }
        case 'prompt': {
          const promptResult = routed.result
          if (promptResult.blocked) {
            appendSystemInfo(`Blocked: ${promptResult.reason}`, 'warning')
            return
          }
          setMessages(prev => [...prev, promptResult.userMessage])
          await submitToModel(promptResult.expandedText)
          return
        }
      }
    },
    [
      historyPath,
      setMessages,
      theme,
      canUseTool,
      store,
      setAppState,
      handleRequestExit,
      vimEnabled,
      commands,
      isLoading,
      permissionMode,
      cwd,
      skipHooks,
      bashExecutor,
      appendSystemInfo,
      submitToModel,
    ],
  )

  // Drain queued prompts once the active streaming turn finishes
  useEffect(() => {
    if (isLoading) return
    const nextQueued = queueManagerRef.current?.dequeue()
    if (nextQueued) {
      setNotices([])
      void handleUserSubmit(nextQueued.text)
    }
  }, [isLoading, handleUserSubmit])

  // Submit optional initial CLI prompt on first mount
  const initialSubmittedRef = useRef(false)
  useEffect(() => {
    if (initialPrompt && !initialSubmittedRef.current) {
      initialSubmittedRef.current = true
      void handleUserSubmit(initialPrompt)
    }
  }, [initialPrompt, handleUserSubmit])

  // Global REPL shortcuts: Ctrl+O transcript expand, Ctrl+C interrupt/exit,
  // Esc cancel streaming, Ctrl+Shift+F search, Ctrl+Shift+P quick open
  useInput(
    useCallback(
      (ch: string, key: Key, event: InputEvent) => {
        if (event.immediatePropagationStopped) return
        if (key.ctrl && ch.toLowerCase() === 'o') {
          setAppState(prev => ({ ...prev, verbose: !prev.verbose }))
          event.stopImmediatePropagation()
          return
        }
        if (key.ctrl && ch.toLowerCase() === 'c') {
          if (isLoading) {
            cancelRequest()
            appendSystemInfo('Interrupted by user.', 'warning')
          } else if (activeCommandOverlay) {
            setActiveCommandOverlay(null)
          } else if (activeModal !== 'none') {
            setActiveModal('none')
          } else if (input.length > 0) {
            setInput('')
          } else {
            handleRequestExit()
          }
          event.stopImmediatePropagation()
          return
        }
        if (key.escape && isLoading && !pendingRequest && !activeCommandOverlay) {
          cancelRequest()
          appendSystemInfo('Interrupted by user.', 'warning')
          event.stopImmediatePropagation()
          return
        }
        if (key.ctrl && key.shift && ch.toLowerCase() === 'f') {
          setActiveModal('search')
          event.stopImmediatePropagation()
          return
        }
        if (key.ctrl && key.shift && ch.toLowerCase() === 'p') {
          setActiveModal('quick_open')
          event.stopImmediatePropagation()
          return
        }
      },
      [
        setAppState,
        isLoading,
        cancelRequest,
        appendSystemInfo,
        activeCommandOverlay,
        activeModal,
        input.length,
        handleRequestExit,
        pendingRequest,
      ],
    ),
  )

  const handleCyclePermissionMode = useCallback(() => {
    setAppState(prev => ({
      ...prev,
      toolPermissionContext: {
        ...prev.toolPermissionContext,
        mode: getNextPermissionMode(prev.toolPermissionContext.mode),
      },
    }))
  }, [setAppState])

  const usedTokens = getTotalInputTokens() + getTotalOutputTokens()
  const contextWindow = 200_000
  const hasBlockingOverlay =
    Boolean(pendingRequest) ||
    Boolean(activeCommandOverlay) ||
    activeModal !== 'none'

  const overlayNode: React.ReactNode = pendingRequest ? (
    <PermissionRequest
      request={pendingRequest}
      width={Math.min(columns - 2, 78)}
      onResolve={resolvePendingRequest}
    />
  ) : activeCommandOverlay ? (
    activeCommandOverlay
  ) : activeModal === 'history' ? (
    <HistorySearchDialog
      entries={historyEntries}
      onAccept={(display, executeNow) => {
        setActiveModal('none')
        if (executeNow) void handleUserSubmit(display)
        else setInput(display)
      }}
      onCancel={() => setActiveModal('none')}
    />
  ) : activeModal === 'search' ? (
    <GlobalSearchDialog
      messages={messages}
      onSelectMessageIndex={idx => {
        setActiveModal('none')
        setStickyBottom(false)
        setJumpToIndex(idx)
      }}
      onCancel={() => setActiveModal('none')}
    />
  ) : activeModal === 'quick_open' ? (
    <QuickOpenDialog
      fileEngine={fileEngine}
      onSelectFile={filePath => {
        setActiveModal('none')
        setInput(prev => `${prev}${prev && !prev.endsWith(' ') ? ' ' : ''}@${filePath} `)
      }}
      onCancel={() => setActiveModal('none')}
    />
  ) : null

  const viewportHeight = Math.max(6, rows - 8)

  const scrollableSlot = (
    <Box flexDirection="column" width={columns}>
      <LogoV2
        model={mainLoopModel}
        cwd={cwd}
        permissionMode={permissionMode}
        compact={messages.length > 0}
      />
      <Messages
        messages={messages}
        columns={columns}
        viewportHeight={viewportHeight}
        scrollRef={scrollRef}
        scrollTop={scrollTop}
        stickyBottom={stickyBottom}
        fullscreen={fullscreen}
        streamingMessageUuid={streamingUuid}
        verbose={verbose}
        jumpToIndex={jumpToIndex}
      />
      {isLoading ? (
        <Box marginTop={1} marginLeft={1}>
          <Spinner mode="thinking" message="Thinking…" />
        </Box>
      ) : null}
    </Box>
  )

  const bottomSlot = (
    <Box flexDirection="column" width={columns}>
      <TokenWarning usedTokens={usedTokens} contextWindow={contextWindow} />
      <StatusNotices notices={notices} />
      <PromptInput
        value={input}
        onChange={setInput}
        onSubmit={val => void handleUserSubmit(val)}
        commands={commands}
        fileEngine={fileEngine}
        historyEntries={historyEntries}
        queuedItems={queue.items}
        permissionMode={permissionMode}
        vimEnabled={vimEnabled}
        isLoading={isLoading}
        isActive={!hasBlockingOverlay}
        columns={columns}
        cwd={cwd}
        onCyclePermissionMode={handleCyclePermissionMode}
        onOpenHistorySearch={() => setActiveModal('history')}
      />
      <StatusLine
        cwd={cwd}
        model={mainLoopModel}
        permissionMode={permissionMode}
        effort={effort}
        fastMode={fastMode}
        vimMode={vimEnabled ? 'INSERT' : null}
        statusLineCommand={statusLineCommand}
        queuedCount={queue.items.length}
      />
      {verbose ? (
        <Box paddingX={1}>
          <ThemedText dimColor>Transcript expanded (Ctrl+O to collapse)</ThemedText>
        </Box>
      ) : null}
    </Box>
  )

  return (
    <>
      <ScrollKeybindingHandler
        scrollRef={scrollRef}
        viewportHeight={viewportHeight}
        isActive={fullscreen && !hasBlockingOverlay}
        onScrollChange={(top, sticky) => {
          setScrollTop(top)
          setStickyBottom(sticky)
        }}
      />
      <FullscreenLayout
        scrollRef={scrollRef}
        stickyBottom={stickyBottom}
        fullscreen={fullscreen}
        scrollable={scrollableSlot}
        bottom={bottomSlot}
        overlay={overlayNode}
      />
    </>
  )
}
