/**
 * React hook hydrating `AppState.fileHistory` from persisted session snapshots
 * once on REPL mount when resuming a session.
 */

import { useEffect, useRef } from 'react'
import {
  fileHistoryEnabled,
  fileHistoryRestoreStateFromLog,
  type FileHistorySnapshot,
  type FileHistoryState,
} from '../utilities/file_history.js'

/**
 * Restores initial file-history snapshots into `AppState` exactly once.
 */
export function useFileHistorySnapshotInit(
  initialFileHistorySnapshots: readonly FileHistorySnapshot[] | undefined,
  _fileHistoryState: FileHistoryState,
  onUpdateState: (newState: FileHistoryState) => void,
): void {
  const initializedRef = useRef(false)

  useEffect(() => {
    if (!fileHistoryEnabled() || initializedRef.current) {
      return
    }
    initializedRef.current = true
    if (initialFileHistorySnapshots && initialFileHistorySnapshots.length > 0) {
      fileHistoryRestoreStateFromLog(initialFileHistorySnapshots, onUpdateState)
    }
  }, [initialFileHistorySnapshots, onUpdateState])
}
