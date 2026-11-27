/**
 * Framework-agnostic snapshot selector for classifier approvals (consumed by
 * TUI components in Phase 5+ via `useSyncExternalStore`).
 */

import {
  type ClassifierApprovalRecord,
  getClassifierApprovals,
  subscribeClassifierApprovals,
} from './classifier_approvals.js'

export function getClassifierApprovalsSnapshot(): readonly ClassifierApprovalRecord[] {
  return getClassifierApprovals()
}

export { subscribeClassifierApprovals }
