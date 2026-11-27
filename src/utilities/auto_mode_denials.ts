/**
 * In-memory audit log of auto-mode classifier denials for the current session.
 */

export interface AutoModeDenialRecord {
  toolName: string
  display: string
  reason: string
  timestamp: number
}

const MAX_RECORDS = 50
const denialRecords: AutoModeDenialRecord[] = []
const listeners = new Set<() => void>()

export function recordAutoModeDenial(record: Omit<AutoModeDenialRecord, 'timestamp'>): void {
  denialRecords.push({ ...record, timestamp: Date.now() })
  if (denialRecords.length > MAX_RECORDS) {
    denialRecords.splice(0, denialRecords.length - MAX_RECORDS)
  }
  for (const listener of listeners) {
    listener()
  }
}

export function getAutoModeDenials(): readonly AutoModeDenialRecord[] {
  return denialRecords
}

export function subscribeAutoModeDenials(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function clearAutoModeDenials(): void {
  denialRecords.length = 0
}
