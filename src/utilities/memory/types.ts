/**
 * Instruction and entrypoint memory file scope classifications
 * (distinct from `memdir/memory_types.ts` topic categories).
 */

import type { MemoryType } from '../../types/forward.js'
import { isFeatureEnabled } from '../feature_flags.js'

export const MEMORY_TYPE_VALUES: readonly MemoryType[] = isFeatureEnabled(
  'TEAMMEM',
)
  ? (['User', 'Project', 'Local', 'Managed', 'AutoMem', 'TeamMem'] as const)
  : (['User', 'Project', 'Local', 'Managed', 'AutoMem'] as const)

export type { MemoryType }
