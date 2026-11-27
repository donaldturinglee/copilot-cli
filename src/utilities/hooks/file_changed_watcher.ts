/**
 * Lightweight watcher controller for `FileChanged` hook `watchPaths`.
 */

import chokidar, { type FSWatcher } from 'chokidar'
import { logForDebugging } from '../debug.js'

export type FileChangedCallback = (
  filePath: string,
  event: 'change' | 'add' | 'unlink',
) => void

let activeWatcher: FSWatcher | null = null
const watchedPaths = new Set<string>()

export function updateFileChangedWatchPaths(
  paths: readonly string[],
  onChange: FileChangedCallback,
): void {
  const newPaths = paths.filter(p => p && !watchedPaths.has(p))
  if (newPaths.length === 0) return

  for (const p of newPaths) {
    watchedPaths.add(p)
  }

  if (!activeWatcher) {
    activeWatcher = chokidar.watch(newPaths, {
      ignoreInitial: true,
      persistent: false,
    })
    activeWatcher.on('change', p => onChange(p, 'change'))
    activeWatcher.on('add', p => onChange(p, 'add'))
    activeWatcher.on('unlink', p => onChange(p, 'unlink'))
    activeWatcher.on('error', err => {
      logForDebugging(
        `FileChanged watcher error: ${err instanceof Error ? err.message : String(err)}`,
        { level: 'warn' },
      )
    })
  } else {
    activeWatcher.add(newPaths)
  }
}

export async function disposeFileChangedWatcher(): Promise<void> {
  if (activeWatcher) {
    await activeWatcher.close()
    activeWatcher = null
  }
  watchedPaths.clear()
}
