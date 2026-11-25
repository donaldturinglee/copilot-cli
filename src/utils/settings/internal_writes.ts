/**
 * Tracks self-initiated writes to settings files so the chokidar watcher can
 * suppress echo events within a 5s window.
 */

const internalWriteTimestamps = new Map<string, number>()

export function markInternalWrite(filePath: string): void {
  internalWriteTimestamps.set(filePath, Date.now())
}

export function consumeInternalWrite(
  filePath: string,
  windowMs: number,
): boolean {
  const timestamp = internalWriteTimestamps.get(filePath)
  if (timestamp === undefined) {
    return false
  }
  if (Date.now() - timestamp < windowMs) {
    internalWriteTimestamps.delete(filePath)
    return true
  }
  internalWriteTimestamps.delete(filePath)
  return false
}

export function clearInternalWrites(): void {
  internalWriteTimestamps.clear()
}
