import React, { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Readable } from 'stream'
import type { CursorDeclaration } from '../cursor.js'
import { TypedEventEmitter } from '../events/emitter.js'
import { InputEvent } from '../events/input_event.js'
import { createEmptyKey, parsedKeyToKey } from '../events/keyboard_event.js'
import { PasteEvent } from '../events/paste_event.js'
import {
  INITIAL_STATE,
  type KeyParseState,
  type ParsedMouse,
  parseMultipleKeypresses,
  type TerminalResponse,
} from '../parse_keypress.js'
import { flushInkSync } from '../reconciler.js'
import { setTerminalFocused } from '../terminal_focus_state.js'
import { AppContext } from './app_context.js'
import { ClockProvider } from './clock_context.js'
import { CursorDeclarationContext } from './cursor_declaration_context.js'
import { ErrorOverview } from './error_overview.js'
import {
  type InternalInputEvents,
  StdinContext,
  type StdinContextValue,
} from './stdin_context.js'
import { TerminalFocusProvider } from './terminal_focus_context.js'
import { TerminalSizeProvider } from './terminal_size_context.js'

type ErrorBoundaryState = { error: Error | null }

class InkErrorBoundary extends Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return <ErrorOverview error={this.state.error} />
    }
    return this.props.children
  }
}

export type AppProps = {
  children: React.ReactNode
  stdin: Readable & { isTTY?: boolean; setRawMode?: (mode: boolean) => void }
  columns: number
  rows: number
  exitOnCtrlC: boolean
  onExit: (error?: Error) => void
  onCursorDeclare?: (decl: CursorDeclaration | null) => void
  onMouse?: (mouse: ParsedMouse) => void
  onTerminalResponse?: (response: TerminalResponse) => void
  inputEmitter?: TypedEventEmitter<InternalInputEvents>
}

export function App({
  children,
  stdin,
  columns,
  rows,
  exitOnCtrlC,
  onExit,
  onCursorDeclare,
  onMouse,
  onTerminalResponse,
  inputEmitter,
}: AppProps): React.ReactNode {
  const emitterRef = useRef<TypedEventEmitter<InternalInputEvents> | null>(
    inputEmitter ?? null,
  )
  if (!emitterRef.current) {
    emitterRef.current = new TypedEventEmitter<InternalInputEvents>()
  }
  const parseStateRef = useRef<KeyParseState>(INITIAL_STATE)
  const [cursorDecl, setCursorDecl] = useState<CursorDeclaration | null>(null)
  const rawModeRef = useRef(0)

  const setRawMode = useCallback(
    (enable: boolean) => {
      if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') return
      if (enable) {
        if (rawModeRef.current === 0) {
          stdin.setRawMode(true)
        }
        rawModeRef.current++
      } else {
        rawModeRef.current = Math.max(0, rawModeRef.current - 1)
        if (rawModeRef.current === 0) {
          stdin.setRawMode(false)
        }
      }
    },
    [stdin],
  )

  const declareCursor = useCallback(
    (decl: CursorDeclaration | null) => {
      setCursorDecl(decl)
      onCursorDeclare?.(decl)
    },
    [onCursorDeclare],
  )

  useEffect(() => {
    const handleData = (chunk: Buffer | string): void => {
      const [events, nextState] = parseMultipleKeypresses(
        parseStateRef.current,
        chunk,
      )
      parseStateRef.current = nextState

      for (const ev of events) {
        if (ev.kind === 'focus') {
          flushInkSync(() => {
            setTerminalFocused(ev.focused)
          })
          continue
        }
        if (ev.kind === 'response') {
          onTerminalResponse?.(ev.response)
          continue
        }
        if (ev.kind === 'mouse') {
          flushInkSync(() => {
            onMouse?.(ev)
            emitterRef.current!.emit('mouse', ev)
            if (ev.action === 'wheel') {
              const key = createEmptyKey()
              key.wheelUp = ev.button === 'wheelUp'
              key.wheelDown = ev.button === 'wheelDown'
              key.ctrl = ev.ctrl
              key.meta = ev.meta
              key.shift = ev.shift
              emitterRef.current!.emit('input', new InputEvent('', key))
            }
          })
          continue
        }

        // ParsedKey
        const { input, key } = parsedKeyToKey(ev)
        if (exitOnCtrlC && key.ctrl && input === 'c') {
          onExit()
          return
        }
        flushInkSync(() => {
          if (ev.isPasted) {
            emitterRef.current!.emit('paste', new PasteEvent(ev.sequence))
          }
          emitterRef.current!.emit('input', new InputEvent(input, key))
        })
      }
    }

    stdin.on('data', handleData)
    return () => {
      stdin.off('data', handleData)
    }
  }, [stdin, exitOnCtrlC, onExit, onMouse, onTerminalResponse])

  const appValue = useMemo(() => ({ exit: onExit }), [onExit])
  const stdinValue = useMemo<StdinContextValue>(
    () => ({
      stdin,
      setRawMode,
      isRawModeSupported: Boolean(stdin.isTTY && typeof stdin.setRawMode === 'function'),
      internal_exitOnCtrlC: exitOnCtrlC,
      internal_eventEmitter: emitterRef.current!,
    }),
    [stdin, setRawMode, exitOnCtrlC],
  )
  const cursorValue = useMemo(
    () => ({ declareCursor, currentCursor: cursorDecl }),
    [declareCursor, cursorDecl],
  )

  return (
    <AppContext.Provider value={appValue}>
      <StdinContext.Provider value={stdinValue}>
        <TerminalSizeProvider columns={columns} rows={rows}>
          <TerminalFocusProvider>
            <ClockProvider>
              <CursorDeclarationContext.Provider value={cursorValue}>
                <InkErrorBoundary>{children}</InkErrorBoundary>
              </CursorDeclarationContext.Provider>
            </ClockProvider>
          </TerminalFocusProvider>
        </TerminalSizeProvider>
      </StdinContext.Provider>
    </AppContext.Provider>
  )
}
