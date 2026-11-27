/**
 * Command & working-directory lifecycle event dispatcher firing `CwdChanged`
 * hooks and refreshing `FileChanged` watch paths when CWD changes.
 */

import { executeCwdChangedHooks, executeFileChangedHooks } from './hooks.js'
import { updateFileChangedWatchPaths } from './hooks/file_changed_watcher.js'

export async function notifyCwdChanged(
  oldCwd: string,
  newCwd: string,
): Promise<void> {
  if (oldCwd === newCwd) return
  const result = await executeCwdChangedHooks({ oldCwd, newCwd })
  if (result.watchPaths.length > 0) {
    updateFileChangedWatchPaths(result.watchPaths, (filePath, event) => {
      void executeFileChangedHooks({ filePath, event })
    })
  }
}
