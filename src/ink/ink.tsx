import React from 'react'
import type { Readable, Writable } from 'stream'
import { FpsTracker, type FpsMetrics } from '../utilities/fps_tracker.js'
import {
  getDefaultRenderOptions,
  type InkRenderOptions,
} from '../utilities/render_options.js'
import { App } from './components/app.js'
import type { InternalInputEvents } from './components/stdin_context.js'
import {
  DEFAULT_FRAME_INTERVAL_MS,
  DEFAULT_TERMINAL_COLUMNS,
  DEFAULT_TERMINAL_ROWS,
} from './constants.js'
import type { CursorDeclaration } from './cursor.js'
import { createNode, type DOMElement } from './dom.js'
import { ClickEvent } from './events/click_event.js'
import { dispatchEvent, type DispatchableNode } from './events/dispatcher.js'
import { TypedEventEmitter } from './events/emitter.js'
import { FocusManager } from './focus.js'
import type { Frame } from './frame.js'
import { hitTest } from './hit_test.js'
import {
  SearchHighlightContext,
  type SearchHighlightContextValue,
} from './hooks/use_search_highlight.js'
import {
  SelectionContext,
  type SelectionContextValue,
} from './hooks/use_selection.js'
import { deleteInkInstance } from './instances.js'
import { LogUpdate } from './log_update.js'
import type { ParsedMouse, TerminalResponse } from './parse_keypress.js'
import {
  createInkFiberRoot,
  flushInkSync,
  inkReconciler,
  resetReconcilerUpdatePriority,
  setReconcilerDiscretePriority,
} from './reconciler.js'
import { DoubleBufferRenderer } from './renderer.js'
import { screenToPlainLines } from './screen.js'
import {
  findScreenMatches,
  type SearchHighlightState,
} from './search_highlight.js'
import {
  clearSelection,
  createSelectionState,
  finishSelection,
  getSelectedText,
  hasSelection,
  type SelectionState,
  startSelection,
  updateSelection,
} from './selection.js'
import { TerminalWriter } from './terminal.js'
import { TerminalQuerier } from './terminal_querier.js'
import { popKittyKeyboard, pushKittyKeyboard } from './termio/csi.js'
import {
  CURSOR_SHOW,
  DISABLE_BRACKETED_PASTE,
  DISABLE_FOCUS_EVENTS,
  DISABLE_MOUSE_TRACKING,
  ENABLE_BRACKETED_PASTE,
  ENABLE_FOCUS_EVENTS,
  ENABLE_MOUSE_TRACKING,
  ENTER_ALT_SCREEN,
  EXIT_ALT_SCREEN,
} from './termio/dec.js'

type WritableTTY = Writable & {
  columns?: number
  rows?: number
  isTTY?: boolean
  on?: (event: string, listener: () => void) => void
  off?: (event: string, listener: () => void) => void
}

type ReadableTTY = Readable & {
  isTTY?: boolean
  setRawMode?: (mode: boolean) => void
}

export class Ink {
  readonly stdout: WritableTTY
  readonly stdin: ReadableTTY
  readonly rootNode: DOMElement
  readonly focusManager: FocusManager
  readonly renderer: DoubleBufferRenderer
  readonly logUpdate: LogUpdate
  readonly writer: TerminalWriter
  readonly fpsTracker = new FpsTracker()
  readonly inputEmitter = new TypedEventEmitter<InternalInputEvents>()
  readonly querier: TerminalQuerier

  private readonly options: ReturnType<typeof getDefaultRenderOptions>
  private readonly fiberRoot: ReturnType<typeof createInkFiberRoot>
  private readonly frameIntervalMs: number
  private readonly selection: SelectionState = createSelectionState()
  private searchState: SearchHighlightState = {
    query: '',
    matches: [],
    activeIndex: 0,
  }
  private cursorDeclaration: CursorDeclaration | null = null
  private currentElement: React.ReactNode = null
  private isUnmounted = false
  private renderTimer: ReturnType<typeof setTimeout> | null = null
  private lastRenderTime = 0
  private lastOutput = ''
  private exitPromise: Promise<void>
  private resolveExit!: () => void
  private rejectExit!: (err: Error) => void

  constructor(userOptions: InkRenderOptions = {}) {
    this.options = getDefaultRenderOptions(userOptions)
    this.stdout = (this.options.stdout ?? process.stdout) as WritableTTY
    this.stdin = (this.options.stdin ?? process.stdin) as ReadableTTY
    this.frameIntervalMs = Math.max(
      1,
      Math.floor(1000 / Math.max(1, this.options.maxFps)),
    )

    this.exitPromise = new Promise<void>((resolve, reject) => {
      this.resolveExit = resolve
      this.rejectExit = reject
    })

    this.rootNode = createNode('ink-root')
    this.focusManager = new FocusManager((target, event) =>
      dispatchEvent(target as DispatchableNode, event),
    )
    this.rootNode.focusManager = this.focusManager

    const viewport = this.getViewport()
    this.renderer = new DoubleBufferRenderer(viewport, {
      altScreen: this.options.altScreen,
    })
    this.logUpdate = new LogUpdate({
      isTTY: Boolean(this.stdout.isTTY),
      stylePool: this.renderer.stylePool,
    })
    this.writer = new TerminalWriter({
      stream: this.stdout,
      stylePool: this.renderer.stylePool,
      synchronizedOutput: Boolean(this.stdout.isTTY),
    })
    this.querier = TerminalQuerier.fromStream(this.stdout)

    this.rootNode.onRender = () => {
      this.scheduleRender()
    }
    this.rootNode.onImmediateRender = () => {
      this.flushRender()
    }

    this.fiberRoot = createInkFiberRoot(this.rootNode, err => {
      const error = err instanceof Error ? err : new Error(String(err))
      this.unmount(error)
    })

    this.setupTerminalModes()
    this.stdout.on?.('resize', this.handleResize)
  }

  getViewport(): { width: number; height: number } {
    return {
      width:
        typeof this.stdout.columns === 'number' && this.stdout.columns > 0
          ? this.stdout.columns
          : DEFAULT_TERMINAL_COLUMNS,
      height:
        typeof this.stdout.rows === 'number' && this.stdout.rows > 0
          ? this.stdout.rows
          : DEFAULT_TERMINAL_ROWS,
    }
  }

  get lastRenderedFrame(): Frame {
    return this.renderer.currentFrame
  }

  get lastWrittenOutput(): string {
    return this.lastOutput
  }

  getPlainScreenLines(): string[] {
    return screenToPlainLines(this.renderer.currentFrame.screen)
  }

  getFpsMetrics(): FpsMetrics {
    return this.fpsTracker.getMetrics()
  }

  getSelectedText(): string {
    return getSelectedText(this.selection, this.renderer.currentFrame.screen)
  }

  clearSelection(): void {
    clearSelection(this.selection)
    this.scheduleRender()
  }

  private setupTerminalModes(): void {
    if (!this.stdout.isTTY) return
    let seq = ''
    if (this.options.altScreen) seq += ENTER_ALT_SCREEN
    if (this.options.bracketedPaste) seq += ENABLE_BRACKETED_PASTE
    if (this.options.mouse) seq += ENABLE_MOUSE_TRACKING
    seq += ENABLE_FOCUS_EVENTS
    if (this.options.kittyKeyboard) seq += pushKittyKeyboard(1)
    if (seq) this.writer.writeRaw(seq)
  }

  private teardownTerminalModes(): void {
    if (!this.stdout.isTTY) return
    let seq = ''
    if (this.options.kittyKeyboard) seq += popKittyKeyboard(1)
    seq += DISABLE_FOCUS_EVENTS
    if (this.options.mouse) seq += DISABLE_MOUSE_TRACKING
    if (this.options.bracketedPaste) seq += DISABLE_BRACKETED_PASTE
    seq += CURSOR_SHOW
    if (this.options.altScreen) seq += EXIT_ALT_SCREEN
    this.writer.writeRaw(seq)
  }

  private readonly handleResize = (): void => {
    if (this.isUnmounted) return
    if (this.currentElement !== null) {
      this.render(this.currentElement)
    }
    this.flushRender()
  }

  private readonly handleMouse = (mouse: ParsedMouse): void => {
    if (this.isUnmounted) return
    const target = hitTest(this.rootNode, mouse.col, mouse.row) ?? this.rootNode

    setReconcilerDiscretePriority()
    try {
      if (mouse.action === 'press' && mouse.button === 'left') {
        this.focusManager.handleClickFocus(target)
        startSelection(this.selection, mouse.col, mouse.row, mouse.meta)
        dispatchEvent(
          target as DispatchableNode,
          new ClickEvent('mousedown', mouse),
        )
      } else if (mouse.action === 'drag' && mouse.button === 'left') {
        updateSelection(this.selection, mouse.col, mouse.row)
        this.scheduleRender()
      } else if (mouse.action === 'release') {
        const hadDrag = hasSelection(this.selection)
        finishSelection(this.selection)
        dispatchEvent(
          target as DispatchableNode,
          new ClickEvent('mouseup', mouse),
        )
        if (!hadDrag) {
          dispatchEvent(
            target as DispatchableNode,
            new ClickEvent('click', mouse),
          )
        }
        this.scheduleRender()
      } else if (mouse.action === 'wheel') {
        dispatchEvent(
          target as DispatchableNode,
          new ClickEvent('wheel', mouse),
        )
      }
    } finally {
      resetReconcilerUpdatePriority()
    }
  }

  private readonly handleTerminalResponse = (
    response: TerminalResponse,
  ): void => {
    this.querier.handleResponse(response)
  }

  private wrapElement(node: React.ReactNode): React.ReactNode {
    const viewport = this.getViewport()
    const selectionValue: SelectionContextValue = {
      selection: this.selection,
      hasSelection: hasSelection(this.selection),
      getSelectedText: () => this.getSelectedText(),
      clearSelection: () => this.clearSelection(),
    }
    const searchValue: SearchHighlightContextValue = {
      state: this.searchState,
      setQuery: query => {
        const matches = findScreenMatches(
          this.renderer.currentFrame.screen,
          query,
        )
        this.searchState = { query, matches, activeIndex: 0 }
        this.scheduleRender()
      },
      nextMatch: () => {
        if (this.searchState.matches.length === 0) return
        this.searchState = {
          ...this.searchState,
          activeIndex:
            (this.searchState.activeIndex + 1) %
            this.searchState.matches.length,
        }
        this.scheduleRender()
      },
      prevMatch: () => {
        if (this.searchState.matches.length === 0) return
        const len = this.searchState.matches.length
        this.searchState = {
          ...this.searchState,
          activeIndex: (this.searchState.activeIndex - 1 + len) % len,
        }
        this.scheduleRender()
      },
      clear: () => {
        this.searchState = { query: '', matches: [], activeIndex: 0 }
        this.scheduleRender()
      },
    }

    return (
      <App
        stdin={this.stdin}
        columns={viewport.width}
        rows={viewport.height}
        exitOnCtrlC={this.options.exitOnCtrlC}
        onExit={err => this.unmount(err)}
        onCursorDeclare={decl => {
          this.cursorDeclaration = decl
          this.scheduleRender()
        }}
        onMouse={this.handleMouse}
        onTerminalResponse={this.handleTerminalResponse}
        inputEmitter={this.inputEmitter}
      >
        <SelectionContext.Provider value={selectionValue}>
          <SearchHighlightContext.Provider value={searchValue}>
            {node}
          </SearchHighlightContext.Provider>
        </SelectionContext.Provider>
      </App>
    )
  }

  render(node: React.ReactNode): void {
    if (this.isUnmounted) return
    this.currentElement = node
    const wrapped = this.wrapElement(node)
    inkReconciler.updateContainerSync(wrapped, this.fiberRoot, null, null)
    flushInkSync()
  }

  scheduleRender(): void {
    if (this.isUnmounted) return
    const now = performance.now()
    const elapsed = now - this.lastRenderTime
    const interval = this.frameIntervalMs || DEFAULT_FRAME_INTERVAL_MS

    if (elapsed >= interval) {
      this.flushRender()
      return
    }

    if (!this.renderTimer) {
      this.renderTimer = setTimeout(() => {
        this.renderTimer = null
        this.flushRender()
      }, Math.max(1, interval - elapsed))
      if (typeof this.renderTimer.unref === 'function') {
        this.renderTimer.unref()
      }
    }
  }

  flushRender(): void {
    if (this.isUnmounted) return
    if (this.renderTimer) {
      clearTimeout(this.renderTimer)
      this.renderTimer = null
    }
    flushInkSync()
    const start = performance.now()
    const viewport = this.getViewport()
    const { prevFrame, nextFrame } = this.renderer.render(
      this.rootNode,
      viewport,
      {
        cursorDeclaration: this.cursorDeclaration,
        selection: this.selection,
        searchHighlight: this.searchState,
      },
    )

    const diff = this.logUpdate.render(
      prevFrame,
      nextFrame,
      this.options.altScreen,
      true,
    )
    this.lastOutput = this.writer.writeDiff(diff)
    const end = performance.now()
    this.lastRenderTime = end
    this.fpsTracker.recordFrame(end - start, end)
  }

  clear(): void {
    this.logUpdate.reset()
  }

  unmount(error?: Error): void {
    if (this.isUnmounted) return
    this.isUnmounted = true

    if (this.renderTimer) {
      clearTimeout(this.renderTimer)
      this.renderTimer = null
    }

    this.stdout.off?.('resize', this.handleResize)
    this.querier.cancel()

    inkReconciler.updateContainerSync(null, this.fiberRoot, null, null)
    inkReconciler.flushSyncWork()

    const doneOps = this.logUpdate.getDoneOps(this.renderer.currentFrame)
    this.writer.writeDiff(doneOps)
    this.teardownTerminalModes()

    deleteInkInstance(this.stdout)

    if (error) {
      this.rejectExit(error)
    } else {
      this.resolveExit()
    }
  }

  waitUntilExit(): Promise<void> {
    return this.exitPromise
  }
}
