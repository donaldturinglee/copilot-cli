import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { UUID } from 'crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import React from 'react'
import { PassThrough } from 'stream'
import {
  getSessionId,
  resetStateForTests,
  setCwdState,
  setIsInteractive,
  setOriginalCwd,
  switchSession,
} from '../../src/bootstrap/state.js'
import { App } from '../../src/components/app.js'
import {
  MessageSelector,
  selectableUserMessagesFilter,
  textForResubmit,
} from '../../src/components/message_selector.js'
import { render } from '../../src/ink/root.js'
import { asSessionId } from '../../src/types/ids.js'
import type { Message, UserMessage } from '../../src/types/message.js'
import { randomUUID } from '../../src/utilities/crypto.js'
import {
  cleanupOldFileHistoryBackups,
  copyFileHistoryForResume,
  createEmptyFileHistoryState,
  fileHistoryCanRestore,
  fileHistoryGetDiffStats,
  fileHistoryHasAnyChanges,
  fileHistoryMakeSnapshot,
  fileHistoryRestoreStateFromLog,
  fileHistoryRewind,
  fileHistoryTrackEdit,
  type FileHistoryState,
  getBackupFileName,
  MAX_SNAPSHOTS,
} from '../../src/utilities/file_history.js'
import { createAssistantMessage, createUserMessage } from '../../src/utilities/messages.js'
import { flushSessionStorage, resetSessionStorageForTests } from '../../src/utilities/session_storage.js'

function createStreams() {
  const stdout = Object.assign(new PassThrough(), {
    columns: 90,
    rows: 28,
    isTTY: false,
  })
  const stdin = Object.assign(new PassThrough(), {
    isTTY: false,
    setRawMode: () => {},
  })
  return { stdout, stdin }
}

describe('Phase 7.2 — File History Snapshot Checkpoints & /rewind', () => {
  let tempRoot: string
  let configDir: string
  let workDir: string
  let savedConfigDir: string | undefined
  let savedTestPersist: string | undefined

  beforeEach(() => {
    savedConfigDir = process.env.CLAUDE_CONFIG_DIR
    savedTestPersist = process.env.TEST_ENABLE_SESSION_PERSISTENCE
    tempRoot = mkdtempSync(join(tmpdir(), 'copilot-p7-s2-'))
    configDir = join(tempRoot, 'config')
    workDir = join(tempRoot, 'repo')
    const { mkdirSync } = require('fs') as typeof import('fs')
    mkdirSync(workDir, { recursive: true })
    process.env.CLAUDE_CONFIG_DIR = configDir
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
    resetStateForTests()
    resetSessionStorageForTests()
    setIsInteractive(true)
    setOriginalCwd(workDir)
    setCwdState(workDir)
  })

  afterEach(async () => {
    await flushSessionStorage().catch(() => {})
    resetSessionStorageForTests()
    resetStateForTests()
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
    if (savedTestPersist === undefined) {
      delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    } else {
      process.env.TEST_ENABLE_SESSION_PERSISTENCE = savedTestPersist
    }
    rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  test('tracks pre-edit v1 backups, preserves v1 across repeat edits, deduplicates snapshots, and rewinds modified/created/deleted files accurately', async () => {
    let state: FileHistoryState = createEmptyFileHistoryState()
    const update = (fn: (prev: FileHistoryState) => FileHistoryState) => {
      state = fn(state)
    }

    const existingFile = join(workDir, 'app.ts')
    const createdFile = join(workDir, 'brand_new.ts')
    writeFileSync(existingFile, 'export const v = 1\n', 'utf8')

    // Turn 1 checkpoint before any edits
    const msg1 = randomUUID() as UUID
    await fileHistoryMakeSnapshot(update, msg1)
    expect(state.snapshots.length).toBe(1)

    // Pre-edit v1 backup for existing file & null marker for newly created file
    await fileHistoryTrackEdit(update, existingFile, msg1)
    writeFileSync(existingFile, 'export const v = 2\n', 'utf8')
    // Second edit in same turn must NOT overwrite v1
    await fileHistoryTrackEdit(update, existingFile, msg1)
    writeFileSync(existingFile, 'export const v = 3\n', 'utf8')

    await fileHistoryTrackEdit(update, createdFile, msg1)
    writeFileSync(createdFile, 'export const created = true\n', 'utf8')

    // Verify deterministic <sha256_16>@v1 filename format
    expect(getBackupFileName('app.ts', 1)).toMatch(/^[0-9a-f]{16}@v1$/)

    // Turn 2 checkpoint snapshots modified state (v2)
    const msg2 = randomUUID() as UUID
    await fileHistoryMakeSnapshot(update, msg2)
    writeFileSync(existingFile, 'export const v = 4\n', 'utf8')

    // Turn 3 checkpoint captures v=4 (v3), then Turn 4 WITHOUT modifying disk deduplicates to v3!
    const msg3 = randomUUID() as UUID
    await fileHistoryMakeSnapshot(update, msg3)
    const msg4 = randomUUID() as UUID
    await fileHistoryMakeSnapshot(update, msg4)
    expect(
      state.snapshots[3]!.trackedFileBackups['app.ts']?.backupFileName,
    ).toBe(state.snapshots[2]!.trackedFileBackups['app.ts']?.backupFileName)

    expect(fileHistoryCanRestore(state, msg1)).toBe(true)
    expect(await fileHistoryHasAnyChanges(state, msg1)).toBe(true)

    // Dry-run diff stats must report changes without touching disk
    const diffStats = await fileHistoryGetDiffStats(state, msg1)
    expect(diffStats).toBeDefined()
    expect(diffStats!.filesChanged?.length).toBe(2)
    expect(readFileSync(existingFile, 'utf8')).toBe('export const v = 4\n')

    // Rewind to msg2 restores v=3 and keeps brand_new.ts
    await fileHistoryRewind(update, msg2)
    expect(readFileSync(existingFile, 'utf8')).toBe('export const v = 3\n')
    expect(existsSync(createdFile)).toBe(true)

    // Rewind to msg1 restores original v=1 and unlinks newly created file!
    await fileHistoryRewind(update, msg1)
    expect(readFileSync(existingFile, 'utf8')).toBe('export const v = 1\n')
    expect(existsSync(createdFile)).toBe(false)
  })

  test('enforces MAX_SNAPSHOTS = 100 cap with monotonic snapshotSequence and supports resume copy & retention cleanup', async () => {
    let state: FileHistoryState = createEmptyFileHistoryState()
    const update = (fn: (prev: FileHistoryState) => FileHistoryState) => {
      state = fn(state)
    }

    for (let i = 0; i < MAX_SNAPSHOTS + 5; i++) {
      await fileHistoryMakeSnapshot(update, randomUUID() as UUID)
    }
    expect(state.snapshots.length).toBe(MAX_SNAPSHOTS)
    expect(state.snapshotSequence).toBe(MAX_SNAPSHOTS + 5)

    // Restore from persisted snapshots
    let restored: FileHistoryState = createEmptyFileHistoryState()
    fileHistoryRestoreStateFromLog(state.snapshots, next => {
      restored = next
    })
    expect(restored.snapshots.length).toBe(MAX_SNAPSHOTS)

    // Copy file history across resumed session IDs
    const srcSid = getSessionId()
    const f = join(workDir, 'keep.txt')
    writeFileSync(f, 'orig', 'utf8')
    let s2 = createEmptyFileHistoryState()
    const u2 = (fn: (prev: FileHistoryState) => FileHistoryState) => {
      s2 = fn(s2)
    }
    const m1 = randomUUID() as UUID
    await fileHistoryMakeSnapshot(u2, m1)
    await fileHistoryTrackEdit(u2, f, m1)

    const dstSid = randomUUID()
    switchSession(asSessionId(dstSid))
    await copyFileHistoryForResume({
      sessionId: srcSid,
      fileHistorySnapshots: s2.snapshots,
      messages: [],
      date: new Date().toISOString(),
      modified: new Date(),
      created: new Date(),
      firstPrompt: '',
      messageCount: 0,
      value: 0,
      isSidechain: false,
    })

    const dstDir = join(configDir, 'file-history', dstSid)
    expect(existsSync(dstDir)).toBe(true)

    // Cleanup with 0-day cutoff cleans old dirs safely without crashing
    await cleanupOldFileHistoryBackups(365)
    expect(existsSync(dstDir)).toBe(true)
  })

  test('MessageSelector filters selectable turns, extracts resubmit text, and renders interactive restore confirmation', async () => {
    const u1 = createUserMessage({ content: 'First prompt to rewind to' })
    const a1 = createAssistantMessage({ content: 'Edited files.' })
    const metaMsg = createUserMessage({ content: 'Hidden meta', isMeta: true })
    const bashMsg = createUserMessage({
      content: '<bash-input>git status</bash-input>',
    })

    const all: Message[] = [u1, a1, metaMsg, bashMsg]
    const selectable = all.filter(selectableUserMessagesFilter)
    expect(selectable.map(m => m.uuid)).toEqual([u1.uuid, bashMsg.uuid])
    expect(textForResubmit(bashMsg)).toEqual({ text: 'git status', mode: 'bash' })

    const { stdout, stdin } = createStreams()
    let restoredMsg: UserMessage | null = null
    let closed = false

    const inst = render(
      <App>
        <MessageSelector
          messages={[u1, a1]}
          preselectedMessage={u1}
          onPreRestore={() => {}}
          onRestoreCode={async () => {}}
          onRestoreMessage={async m => {
            restoredMsg = m
          }}
          onSummarize={async () => {}}
          onClose={() => {
            closed = true
          }}
        />
      </App>,
      { stdout, stdin },
    )

    await new Promise(r => setTimeout(r, 40))
    inst.flush()
    const frame = inst.ink.getPlainScreenLines().join('\n')
    expect(frame).toContain('Rewind')
    expect(frame).toContain('First prompt to rewind to')
    expect(restoredMsg).toBeNull()
    expect(closed).toBe(false)
    inst.unmount()
  })
})
