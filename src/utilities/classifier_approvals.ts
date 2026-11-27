/**
 * Tracks actions approved by the auto-mode transcript classifier during the
 * active session for status/audit inspection.
 */

export interface ClassifierApprovalRecord {
  toolName: string
  summary: string
  reason: string
  stage: 'fast' | 'thinking'
  timestamp: number
}

const MAX_APPROVALS = 100
const approvals: ClassifierApprovalRecord[] = []
const listeners = new Set<() => void>()

export function recordClassifierApproval(
  record: Omit<ClassifierApprovalRecord, 'timestamp'>,
): void {
  approvals.push({ ...record, timestamp: Date.now() })
  if (approvals.length > MAX_APPROVALS) {
    approvals.splice(0, approvals.length - MAX_APPROVALS)
  }
  for (const listener of listeners) {
    listener()
  }
}

export function getClassifierApprovals(): readonly ClassifierApprovalRecord[] {
  return approvals
}

export function subscribeClassifierApprovals(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function clearClassifierApprovals(): void {
  approvals.length = 0
}
