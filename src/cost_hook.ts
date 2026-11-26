/**
 * React hook printing the session cost summary and saving costs on process exit.
 */

import { useEffect } from 'react'
import {
  type FpsMetrics,
  formatTotalCost,
  saveCurrentSessionCosts,
} from './cost_tracker.js'
import { hasConsoleBillingAccess } from './utilities/billing.js'

/**
 * Registers a process `exit` listener that prints cost summaries for Console
 * billing users and persists session cost stats.
 */
export function useCostSummary(
  getFpsMetrics?: () => FpsMetrics | undefined,
): void {
  useEffect(() => {
    const onExit = () => {
      if (hasConsoleBillingAccess()) {
        process.stdout.write('\n' + formatTotalCost() + '\n')
      }
      saveCurrentSessionCosts(getFpsMetrics?.())
    }
    process.on('exit', onExit)
    return () => {
      process.off('exit', onExit)
    }
  }, [getFpsMetrics])
}
